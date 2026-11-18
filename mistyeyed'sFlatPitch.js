function getClientInfo() {
    return {
        "name": "FlatPitch",
        "category": "mistyeyed's",
        "author": "mistyeyed",
        "versionNumber": 1,
        // 0x020100 = 2.1.0: pitch-control API is "supported since 2.1.0".
        "minEditorVersion": 131328
    };
}

// Smoothstep easing: S-curve with zero slope at both ends.
function smoothstep01(f) {
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    return f * f * (3 - 2 * f);
}

var ADJACENCY_TOLERANCE_SEC = 0.02;
var RAMP_SAMPLES = 12;

// Time converter bound to the project time axis once.
function makeSecToBlick() {
    var timeAxis = SV.getProject().getTimeAxis();
    var hasConv = timeAxis &&
        typeof timeAxis.getSecondsFromBlick === "function" &&
        typeof timeAxis.getBlickFromSeconds === "function";
    return function (sec, position) {
        if (hasConv) {
            return timeAxis.getBlickFromSeconds(
                timeAxis.getSecondsFromBlick(position) + sec
            ) - position;
        }
        var bpm = 120;
        if (timeAxis && typeof timeAxis.getTempoMarkAt === "function") {
            var mark = timeAxis.getTempoMarkAt(position);
            if (mark && typeof mark.bpm === "number") bpm = mark.bpm;
        }
        return sec * SV.QUARTER * bpm / 60;
    };
}

// Build points for one free gap. ALWAYS spans [0, segDur] completely.
function buildGapPoints(segDur, entry, exit, pitch) {
    var pts = [];
    var eDur = entry ? Math.min(entry.dur, segDur) : 0;
    var xDur = exit ? Math.min(exit.dur, segDur - eDur) : 0;
    var xStart = segDur - xDur;
    var i, u, f, val;

    if (eDur > 0) {
        for (i = 0; i < RAMP_SAMPLES; i++) {
            u = i / RAMP_SAMPLES;
            f = entry.half ? (0.5 + 0.5 * u) : u;
            val = entry.from + (entry.to - entry.from) * smoothstep01(f);
            pts.push([eDur * u, val - pitch]);
        }
        pts.push([eDur, entry.to - pitch]);
    } else {
        pts.push([0, 0]);
    }

    if (xDur > 0) {
        if (xStart > pts[pts.length - 1][0]) pts.push([xStart, exit.from - pitch]);
        for (i = 1; i <= RAMP_SAMPLES; i++) {
            u = i / RAMP_SAMPLES;
            f = exit.half ? (0.5 * u) : u;
            val = exit.from + (exit.to - exit.from) * smoothstep01(f);
            pts.push([xStart + xDur * u, val - pitch]);
        }
    } else if (pts[pts.length - 1][0] < segDur) {
        pts.push([segDur, 0]);
    }
    return pts;
}

function main() {
    var form = {
        title: "FlatPitch",
        buttons: "OkCancel",
        widgets: [
            { type: "TextBox", name: "smoothSec", label: "Transition duration (seconds), 0 = off", default: "0.070" },
            { type: "CheckBox", name: "keepCurves", text: "Keep existing curves", default: false },
            { type: "CheckBox", name: "keepPoints", text: "Keep existing points", default: false }
        ]
    };

    var result = SV.showCustomDialog(form);
    if (!result || result.status !== true) { SV.finish(); return; }

    var saveCurves = result.answers["keepCurves"];
    var savePoints = result.answers["keepPoints"];
    var smoothSec = parseFloat(String(result.answers["smoothSec"]).replace(",", "."));
    if (isNaN(smoothSec) || smoothSec < 0) smoothSec = 0;
    if (smoothSec > 0.5) smoothSec = 0.5;

    var editor = SV.getMainEditor();
    var selection = editor.getSelection();
    var selectedNotes = selection.getSelectedNotes();
    if (!selectedNotes || selectedNotes.length === 0) {
        SV.showMessageBox("FlatPitch", "Select at least one note.");
        SV.finish(); return;
    }

    var group = editor.getCurrentGroup().getTarget();
    var secToBlick = makeSecToBlick();

    // ===== READ ONCE =====
    var notes = [];
    var numNotes = group.getNumNotes();
    for (var i = 0; i < numNotes; i++) {
        var n = group.getNote(i);
        notes.push({ idx: i, onset: n.getOnset(), end: n.getEnd(), pitch: n.getPitch() });
    }

    var controls = [];
    var numCtrl = group.getNumPitchControls();
    for (var c = 0; c < numCtrl; c++) {
        var ctrl = group.getPitchControl(c);
        var pos = ctrl.getPosition();
        var isCurve = (typeof ctrl.getPoints === "function");
        var lo = pos, hi = pos;
        if (isCurve) {
            var cp = ctrl.getPoints();
            if (cp && cp.length > 0) {
                lo = pos + cp[0][0]; hi = pos + cp[0][0];
                for (var p = 1; p < cp.length; p++) {
                    var t = pos + cp[p][0];
                    if (t < lo) lo = t;
                    if (t > hi) hi = t;
                }
            }
        }
        controls.push({ index: c, pos: pos, lo: lo, hi: hi, isCurve: isCurve });
    }

    // Selected notes matched to cached indices.
    var sel = [];
    var selSet = {};
    for (var i = 0; i < selectedNotes.length; i++) {
        var sn = selectedNotes[i];
        var so = sn.getOnset(), se = sn.getEnd(), sp = sn.getPitch();
        var matchIdx = -1;
        for (var k = 0; k < notes.length; k++) {
            if (notes[k].onset === so && notes[k].end === se && notes[k].pitch === sp && !selSet[notes[k].idx]) {
                matchIdx = notes[k].idx; break;
            }
        }
        if (matchIdx < 0) continue;
        selSet[matchIdx] = true;
        sel.push({ idx: matchIdx, onset: so, end: se, pitch: sp });
    }
    if (sel.length === 0) { SV.finish(); return; }

    // IMPORTANT: neighbor links used for the shared-duration commit must point
    // at SEL objects (where reserves/durations live), not at the notes cache.
    var selByIdx = {};
    for (var i = 0; i < sel.length; i++) selByIdx[sel[i].idx] = sel[i];

    var deleted = {};

    // ===== PASS 1: mark unwanted controls =====
    for (var i = 0; i < sel.length; i++) {
        var onset = sel[i].onset, end = sel[i].end;
        for (var c = 0; c < controls.length; c++) {
            var d = controls[c];
            if (deleted[d.index]) continue;
            if (d.hi <= onset || d.lo >= end) continue;
            if ((d.isCurve && !saveCurves) || (!d.isCurve && !savePoints)) deleted[d.index] = true;
        }
    }

    // ===== PASS 2: gaps, neighbors, reserves =====
    for (var i = 0; i < sel.length; i++) {
        var s = sel[i];
        var onset = s.onset, end = s.end, pitch = s.pitch;

        var tol = secToBlick(ADJACENCY_TOLERANCE_SEC, onset);
        var prevNote = null, nextNote = null;
        var bestPrevOnset = -Infinity, bestNextOnset = Infinity;
        for (var k = 0; k < notes.length; k++) {
            var cd = notes[k];
            if (cd.idx === s.idx) continue;
            if (cd.onset < onset && cd.end >= onset - tol && cd.onset > bestPrevOnset) {
                bestPrevOnset = cd.onset; prevNote = cd;
            }
            if (cd.onset > onset && cd.onset <= end + tol && cd.onset < bestNextOnset) {
                bestNextOnset = cd.onset; nextNote = cd;
            }
        }
        s.prevNote = prevNote;
        s.nextNote = nextNote;
        s.prevSel = prevNote ? (selByIdx[prevNote.idx] || null) : null;
        s.nextSel = nextNote ? (selByIdx[nextNote.idx] || null) : null;
        s.prevPitch = prevNote ? prevNote.pitch : pitch;
        s.nextPitch = nextNote ? nextNote.pitch : pitch;
        s.Bnext = nextNote ? Math.min(end, nextNote.onset) : end;

        s.fullBlicks = smoothSec > 0 ? secToBlick(smoothSec, onset) : 0;
        s.halfBlicks = smoothSec > 0 ? secToBlick(smoothSec / 2, onset) : 0;

        var occupied = [], pointPositions = [];
        for (var c = 0; c < controls.length; c++) {
            var d = controls[c];
            if (deleted[d.index]) continue;
            if (d.isCurve) {
                var cStart = Math.max(d.lo, onset);
                var cEnd = Math.min(d.hi, end);
                if (cStart < cEnd) occupied.push([cStart, cEnd]);
            } else {
                if (d.pos >= onset && d.pos <= end) pointPositions.push(d.pos);
            }
        }
        if (pointPositions.length > 0) {
            pointPositions.sort(function (a, b) { return a - b; });
            var mn = pointPositions[0], mx = pointPositions[pointPositions.length - 1];
            if (mn === mx) occupied.push([mn, mn]);
            else occupied.push([Math.max(mn, onset), Math.min(mx, end)]);
        }
        occupied.sort(function (a, b) { return a[0] - b[0]; });
        var merged = [];
        for (var j = 0; j < occupied.length; j++) {
            if (merged.length === 0 || occupied[j][0] > merged[merged.length - 1][1]) {
                merged.push([occupied[j][0], occupied[j][1]]);
            } else {
                merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], occupied[j][1]);
            }
        }
        var free = [];
        var cur = onset;
        for (var k = 0; k < merged.length; k++) {
            if (cur < merged[k][0]) free.push([cur, merged[k][0]]);
            cur = Math.max(cur, merged[k][1]);
        }
        if (cur < end) free.push([cur, end]);

        if (free.length > 0 && free[free.length - 1][1] === end) {
            free[free.length - 1][1] = s.Bnext;
        }
        var gaps = [];
        for (var g = 0; g < free.length; g++) {
            if (free[g][1] > free[g][0]) gaps.push(free[g]);
        }
        s.gaps = gaps;
        s.single = (gaps.length === 1);
        s.firstDur = gaps.length ? gaps[0][1] - gaps[0][0] : 0;
        s.lastDur = gaps.length ? gaps[gaps.length - 1][1] - gaps[gaps.length - 1][0] : 0;
        s.entryEligible = gaps.length > 0 && gaps[0][0] === onset;
        s.exitEligible = gaps.length > 0 && gaps[gaps.length - 1][1] === s.Bnext;

        var h = s.halfBlicks;
        s.entryReserveHalf = s.single ? Math.min(h, s.firstDur / 2) : Math.min(h, s.firstDur);
        s.exitReserveHalf = s.single ? Math.min(h, s.lastDur / 2) : Math.min(h, s.lastDur);
        s.entrySpaceFull = s.single ? Math.max(0, s.firstDur - s.exitReserveHalf) : s.firstDur;
        s.exitSpaceFull = s.single ? Math.max(0, s.lastDur - s.entryReserveHalf) : s.lastDur;

        s.entryDur = 0; s.entryHalf = false; s.entryFrom = pitch;
        s.exitDur = 0; s.exitHalf = false; s.exitTo = pitch;
    }

    // ===== PASS 3: shared per-boundary durations, then build curves =====
    sel.sort(function (a, b) { return a.onset - b.onset; });
    var additions = [];
    for (var i = 0; i < sel.length; i++) {
        var s = sel[i];
        var pitch = s.pitch;

        // Entry: if prev is selected, its exit pass already committed our
        // entryDur/entryHalf/entryFrom onto THIS sel object (sorted order).
        if (s.prevNote && s.entryEligible && s.fullBlicks > 0) {
            if (s.prevSel) {
                s.entryHalf = true;
                s.entryFrom = s.prevPitch;
                // entryDur stays as committed (0 if prev could not exit)
            } else {
                s.entryDur = Math.min(s.fullBlicks, s.entrySpaceFull);
                s.entryHalf = false;
                s.entryFrom = s.prevPitch;
            }
        }

        // Exit: decide the shared half and commit it to the next SEL object.
        if (s.nextNote && s.exitEligible && s.fullBlicks > 0) {
            if (s.nextSel) {
                if (s.nextSel.entryEligible) {
                    var halfAB = Math.min(s.halfBlicks, s.exitReserveHalf, s.nextSel.entryReserveHalf);
                    if (halfAB > 0) {
                        s.exitDur = halfAB;
                        s.exitHalf = true;
                        s.exitTo = s.nextPitch;
                        s.nextSel.entryDur = halfAB;
                        s.nextSel.entryHalf = true;
                        s.nextSel.entryFrom = pitch;
                    }
                }
                // else: the next note's head is occupied by a kept control,
                // so no exit ramp is drawn here (flat step instead of a jump)
            } else {
                s.exitDur = Math.min(s.fullBlicks, s.exitSpaceFull);
                s.exitHalf = false;
                s.exitTo = s.nextPitch;
            }
        }

        for (var g = 0; g < s.gaps.length; g++) {
            var segStart = s.gaps[g][0];
            var segEnd = s.gaps[g][1];
            var segDur = segEnd - segStart;
            if (segDur <= 0) continue;

            var entry = null, exit = null;
            if (g === 0 && s.entryEligible && s.entryDur > 0) {
                entry = { dur: s.entryDur, from: s.entryFrom, to: pitch, half: s.entryHalf };
            }
            if (g === s.gaps.length - 1 && s.exitEligible && s.exitDur > 0) {
                exit = { dur: s.exitDur, from: pitch, to: s.exitTo, half: s.exitHalf };
            }
            additions.push({
                pos: segStart,
                pitch: pitch,
                points: buildGapPoints(segDur, entry, exit, pitch)
            });
        }
    }

    // ===== WRITE ONCE =====
    var toRemove = [];
    for (var key in deleted) {
        if (deleted.hasOwnProperty(key)) toRemove.push(parseInt(key, 10));
    }
    toRemove.sort(function (a, b) { return b - a; });
    for (var r = 0; r < toRemove.length; r++) group.removePitchControl(toRemove[r]);

    for (var a = 0; a < additions.length; a++) {
        var ad = additions[a];
        if (ad.points.length === 0) continue;
        var curve = SV.create("PitchControlCurve");
        curve.setPosition(ad.pos);
        curve.setPitch(ad.pitch);
        curve.setPoints(ad.points);
        group.addPitchControl(curve);
    }

    SV.showMessageBox("FlatPitch",
        "Done! Pitch has been flattened.\nYou can undo with Ctrl+Z.");
    SV.finish();
}