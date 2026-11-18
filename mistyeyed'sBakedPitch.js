function getClientInfo() {
    return {
        "name": "BakedPitch",
        "category": "mistyeyed's",
        "author": "mistyeyed",
        "versionNumber": 1,
        // 0x020101 = 2.1.1: required for SV.getComputedPitchForGroup()
        // and the PitchControlCurve / pitch-control enumeration API.
        "minEditorVersion": 131329
    };
}

// Simplest easing: S-curve with zero slope at both ends.
function smoothstep01(f) {
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    return f * f * (3 - 2 * f);
}

// Linear interpolation of a polyline at time t (points sorted by time).
function lerpValueAt(pts, t) {
    if (t <= pts[0][0]) return pts[0][1];
    var last = pts[pts.length - 1];
    if (t >= last[0]) return last[1];
    for (var i = 1; i < pts.length; i++) {
        if (pts[i][0] >= t) {
            var a = pts[i - 1], b = pts[i];
            var dt = b[0] - a[0];
            var f = dt > 0 ? (t - a[0]) / dt : 0;
            return a[1] + (b[1] - a[1]) * f;
        }
    }
    return last[1];
}

// Subtract sorted baked ranges from [cLo, cHi]; returns keep-intervals.
function keepIntervalsFor(cLo, cHi, baked) {
    var res = [];
    var cur = cLo;
    for (var i = 0; i < baked.length; i++) {
        var b = baked[i];
        if (b[1] <= cur) continue;
        if (b[0] >= cHi) break;
        if (b[0] > cur) res.push([cur, Math.min(b[0], cHi)]);
        cur = Math.max(cur, b[1]);
        if (cur >= cHi) break;
    }
    if (cur < cHi) res.push([cur, cHi]);
    return res;
}

function inRanges(t, ranges) {
    for (var i = 0; i < ranges.length; i++) {
        if (t >= ranges[i][0] && t < ranges[i][1]) return true;
        if (ranges[i][0] > t) break;
    }
    return false;
}

// Iterative Douglas-Peucker simplification (value axis, semitones).
function simplifyDP(points, epsilon) {
    if (points.length <= 2) return points;
    var keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    var stack = [[0, points.length - 1]];
    while (stack.length > 0) {
        var range = stack.pop();
        var start = range[0], end = range[1];
        var t1 = points[start][0], v1 = points[start][1];
        var t2 = points[end][0], v2 = points[end][1];
        var dt = t2 - t1;
        var maxDist = 0, maxIdx = -1;
        if (Math.abs(dt) < 1) {
            for (var i = start + 1; i < end; i++) {
                var dist = Math.abs(points[i][1] - v1);
                if (dist > maxDist) { maxDist = dist; maxIdx = i; }
            }
        } else {
            var slope = (v2 - v1) / dt;
            for (var i = start + 1; i < end; i++) {
                var expected = v1 + slope * (points[i][0] - t1);
                var dist = Math.abs(points[i][1] - expected);
                if (dist > maxDist) { maxDist = dist; maxIdx = i; }
            }
        }
        if (maxIdx !== -1 && maxDist > epsilon) {
            keep[maxIdx] = 1;
            if (maxIdx - start > 1) stack.push([start, maxIdx]);
            if (end - maxIdx > 1) stack.push([maxIdx, end]);
        }
    }
    var result = [];
    for (var i = 0; i < points.length; i++) {
        if (keep[i]) result.push(points[i]);
    }
    return result;
}

function main() {
    var QUARTER             = SV.QUARTER;
    var SAMPLE_DIV          = 256;
    var GAP_MARGIN          = Math.floor(QUARTER / 4);
    var PITCH_SANITY_MARGIN = 8;   // hardcoded per user decision
    var MAX_FRAMES          = 100000;
    var SIMPLIFY            = true;
    var SIMPLIFY_EPSILON    = 0.02;
    var SPECIAL = { "sil": 1, "cl": 1, "vf": 1, "br": 1 };

    var editor = SV.getMainEditor();
    var selection = editor.getSelection();
    var selectedNotes = selection.getSelectedNotes();

    if (selectedNotes.length === 0) {
        SV.showMessageBox("BakedPitch", "Select the notes whose pitch you want to bake.");
        SV.finish(); return;
    }

    var groupRef = editor.getCurrentGroup();
    var noteGroup = groupRef.getTarget();
    var timeOffset = groupRef.getTimeOffset();
    var pitchOffset = groupRef.getPitchOffset();

    // ===== READ ONCE: notes =====
    var allNotes = [];
    var numNotes = noteGroup.getNumNotes();
    for (var i = 0; i < numNotes; i++) {
        var n = noteGroup.getNote(i);
        var lyr = String(n.getLyrics()).toLowerCase().replace(/^\s+|\s+$/g, "");
        allNotes.push({
            onset: n.getOnset(), end: n.getEnd(), pitch: n.getPitch(),
            lyrics: lyr, isSpecial: !!SPECIAL[lyr]
        });
    }

    var regularSelected = [];
    var selMap = {};
    var minOnsetSel = Infinity, maxEndSel = -Infinity;
    var minPitch = Infinity, maxPitch = -Infinity;
    for (var i = 0; i < selectedNotes.length; i++) {
        var n = selectedNotes[i];
        var lyr = String(n.getLyrics()).toLowerCase().replace(/^\s+|\s+$/g, "");
        if (SPECIAL[lyr]) continue;
        var o = n.getOnset(), e = n.getEnd(), p = n.getPitch();
        regularSelected.push({ onset: o, end: e, pitch: p });
        selMap[o + ":" + e] = true;
        if (o < minOnsetSel) minOnsetSel = o;
        if (e > maxEndSel)   maxEndSel   = e;
        if (p < minPitch)    minPitch    = p;
        if (p > maxPitch)    maxPitch    = p;
    }

    if (regularSelected.length === 0) {
        SV.showMessageBox("BakedPitch", "The selection contains no sounding notes — nothing to bake.");
        SV.finish(); return;
    }
    regularSelected.sort(function(a, b) { return a.onset - b.onset; });

    // Barriers: unselected regular notes must never be baked (P1.4).
    var barriers = [];
    for (var i = 0; i < allNotes.length; i++) {
        var n = allNotes[i];
        if (n.isSpecial) continue;
        if (selMap[n.onset + ":" + n.end]) continue;
        barriers.push([n.onset, n.end]);
    }
    barriers.sort(function(a, b) { return a[0] - b[0]; });

    // ===== SEGMENTS =====
    var intervals = [];
    for (var i = 0; i < regularSelected.length; i++) {
        var r = regularSelected[i];
        intervals.push({ start: Math.max(0, r.onset - GAP_MARGIN), end: r.end + GAP_MARGIN });
    }
    var activeStart = Math.max(0, minOnsetSel - GAP_MARGIN);
    var activeEnd   = maxEndSel + GAP_MARGIN;
    for (var i = 0; i < allNotes.length; i++) {
        var n = allNotes[i];
        if (!n.isSpecial) continue;
        if (n.end <= activeStart || n.onset >= activeEnd) continue;
        var neighbor = false;
        for (var j = 0; j < regularSelected.length; j++) {
            var r = regularSelected[j];
            if (n.end >= r.onset - GAP_MARGIN && n.onset <= r.end + GAP_MARGIN) {
                neighbor = true; break;
            }
        }
        if (neighbor) intervals.push({ start: n.onset, end: n.end });
    }

    intervals.sort(function(a, b) { return a.start - b.start; });
    var merged = [];
    for (var i = 0; i < intervals.length; i++) {
        if (merged.length === 0 || intervals[i].start > merged[merged.length - 1].end) {
            merged.push({ start: intervals[i].start, end: intervals[i].end });
        } else {
            var last = merged[merged.length - 1];
            last.end = Math.max(last.end, intervals[i].end);
        }
    }

    // Subtract barriers so no unselected regular note lies inside a segment.
    var segments = [];
    for (var s = 0; s < merged.length; s++) {
        var cur = merged[s].start;
        var segEnd = merged[s].end;
        for (var b = 0; b < barriers.length; b++) {
            var br = barriers[b];
            if (br[1] <= cur) continue;
            if (br[0] >= segEnd) break;
            if (br[0] > cur) segments.push({ start: cur, end: Math.min(br[0], segEnd) });
            cur = Math.max(cur, br[1]);
            if (cur >= segEnd) break;
        }
        if (cur < segEnd) segments.push({ start: cur, end: segEnd });
    }

    // Drop segments that contain no selected regular note.
    var keptSegments = [];
    for (var s = 0; s < segments.length; s++) {
        var has = false;
        for (var i = 0; i < regularSelected.length; i++) {
            var r = regularSelected[i];
            if (r.end > segments[s].start && r.onset < segments[s].end) { has = true; break; }
        }
        if (has) keptSegments.push(segments[s]);
    }
    segments = keptSegments;

    if (segments.length === 0) {
        SV.showMessageBox("BakedPitch", "Nothing to bake after excluding unselected notes.");
        SV.finish(); return;
    }

    var overallStart = segments[0].start;
    var overallEnd   = segments[segments.length - 1].end;
    var overallDuration = overallEnd - overallStart;

    // Per-segment contents + per-segment sanity range (P1.3).
    var segmentSpecial = [], segmentRegularAll = [], segmentRegularSel = [];
    var segMin = [], segMax = [];
    for (var s = 0; s < segments.length; s++) {
        var sp = [], ra = [], rs = [];
        for (var i = 0; i < allNotes.length; i++) {
            var n = allNotes[i];
            var inside = (n.end > segments[s].start && n.onset < segments[s].end);
            if (!inside) continue;
            if (n.isSpecial) sp.push(n);
            else ra.push(n);
        }
        for (var i = 0; i < regularSelected.length; i++) {
            var r = regularSelected[i];
            if (r.end > segments[s].start && r.onset < segments[s].end) rs.push(r);
        }
        segmentSpecial.push(sp);
        segmentRegularAll.push(ra);
        segmentRegularSel.push(rs);

        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < ra.length; i++) {
            if (ra[i].pitch < lo) lo = ra[i].pitch;
            if (ra[i].pitch > hi) hi = ra[i].pitch;
        }
        if (lo === Infinity) { lo = minPitch; hi = maxPitch; }
        segMin.push(lo);
        segMax.push(hi);
    }

    function findSegment(t) {
        var lo = 0, hi = segments.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (segments[mid].end <= t) lo = mid + 1; else hi = mid;
        }
        if (lo < segments.length && t >= segments[lo].start && t < segments[lo].end) return lo;
        return -1;
    }

    function isInRegularIn(s, t) {
        var ra = segmentRegularAll[s];
        for (var i = 0; i < ra.length; i++) {
            if (t >= ra[i].onset && t < ra[i].end) return true;
        }
        return false;
    }

    var targetInterval = Math.floor(QUARTER / SAMPLE_DIV);
    var blickInterval  = Math.max(targetInterval, Math.floor(overallDuration / MAX_FRAMES));
    var numFrames      = Math.floor(overallDuration / blickInterval) + 1;
    var absStart       = overallStart + timeOffset;

    var attempts = 0, MAX_ATTEMPTS = 50;
    function doSample() {
        attempts++;
        var pitchValues = SV.getComputedPitchForGroup(groupRef, absStart, blickInterval, numFrames);
        if (!pitchValues || pitchValues.length === 0) {
            if (attempts < MAX_ATTEMPTS) { SV.setTimeout(200, doSample); return; }
            SV.showMessageBox("BakedPitch",
                "SynthV has not computed the pitch for this fragment yet.\n" +
                "Play it through once and run the script again.");
            SV.finish(); return;
        }
        proceed(pitchValues);
    }

    function proceed(pitchValues) {
        var n = Math.min(numFrames, pitchValues.length);

        var originalValid = new Uint8Array(n);
        var values = new Array(n);
        for (var i = 0; i < n; i++) {
            var v = pitchValues[i];
            var t = overallStart + i * blickInterval;
            var s = findSegment(t);
            var ok = false;
            if (s >= 0) {
                ok = (typeof v === "number") && isFinite(v)
                    && v >= segMin[s] - PITCH_SANITY_MARGIN
                    && v <= segMax[s] + PITCH_SANITY_MARGIN
                    && isInRegularIn(s, t);
            }
            originalValid[i] = ok ? 1 : 0;
            values[i] = ok ? v : null;
        }

        var filledSpecial = new Uint8Array(n);
        var curveData = [];

        for (var s = 0; s < segments.length; s++) {
            var frameLo = Math.max(0, Math.floor((segments[s].start - overallStart) / blickInterval));
            var frameHi = Math.min(n - 1, Math.ceil((segments[s].end - overallStart) / blickInterval));
            if (frameLo > frameHi) { curveData.push(null); continue; }

            function timeOf(i) { return overallStart + i * blickInterval; }

            var regs = segmentSpecial[s];
            for (var r = 0; r < regs.length; r++) {
                var reg = regs[r];
                var fs = Math.max(frameLo, Math.floor((reg.onset - overallStart) / blickInterval));
                var fe = Math.min(frameHi, Math.ceil((reg.end - overallStart) / blickInterval));
                if (fs > fe) continue;

                var leftVal = null;
                for (var i = fs - 1; i >= frameLo; i--) {
                    if (originalValid[i]) { leftVal = values[i]; break; }
                }
                var rightVal = null;
                for (var i = fe + 1; i <= frameHi; i++) {
                    if (originalValid[i]) { rightVal = values[i]; break; }
                }
                var leftEnd  = (leftVal  !== null) ? leftVal  : reg.pitch;
                var rightEnd = (rightVal !== null) ? rightVal : reg.pitch;
                var t0 = timeOf(fs), t1 = timeOf(fe);
                var span = t1 - t0;
                for (var i = fs; i <= fe; i++) {
                    var eased = span > 0 ? smoothstep01((timeOf(i) - t0) / span) : 0.5;
                    values[i] = leftEnd + (rightEnd - leftEnd) * eased;
                    filledSpecial[i] = 1;
                }
            }

            function isFilled(i) { return originalValid[i] || filledSpecial[i]; }

            var rs = segmentRegularSel[s];
            var firstRegPitch = rs.length > 0 ? rs[0].pitch : 60;
            var lastRegPitch  = rs.length > 0 ? rs[rs.length - 1].pitch : 60;

            var i = frameLo;
            while (i <= frameHi) {
                if (isFilled(i)) { i++; continue; }
                var j = i;
                while (j <= frameHi && !isFilled(j)) j++;

                var leftVal = null;
                for (var k = i - 1; k >= frameLo; k--) {
                    if (isFilled(k)) { leftVal = values[k]; break; }
                }
                var rightVal = null;
                for (var k = j; k <= frameHi; k++) {
                    if (isFilled(k)) { rightVal = values[k]; break; }
                }
                var leftEnd  = (leftVal  !== null) ? leftVal  : firstRegPitch;
                var rightEnd = (rightVal !== null) ? rightVal : lastRegPitch;
                var t0 = timeOf(i), t1 = timeOf(j - 1);
                var span = t1 - t0;
                for (var k = i; k < j; k++) {
                    var eased = span > 0 ? smoothstep01((timeOf(k) - t0) / span) : 0.5;
                    values[k] = leftEnd + (rightEnd - leftEnd) * eased;
                }
                i = j;
            }

            var anchor = null;
            for (var fi = frameLo; fi <= frameHi; fi++) {
                if (originalValid[fi]) { anchor = values[fi]; break; }
            }
            if (anchor === null) anchor = values[frameLo];
            if (anchor === null) { curveData.push(null); continue; }

            var anchorAbs = Math.round(anchor);
            var points = [];
            for (var fi = frameLo; fi <= frameHi; fi++) {
                if (values[fi] !== null) {
                    points.push([timeOf(fi) - segments[s].start, values[fi] - anchorAbs]);
                }
            }
            if (SIMPLIFY && points.length > 2) points = simplifyDP(points, SIMPLIFY_EPSILON);
            if (points.length === 0) { curveData.push(null); continue; }

            curveData.push({
                segStart: segments[s].start,
                segEnd: segments[s].start + points[points.length - 1][0],
                anchorRel: anchorAbs - pitchOffset,
                points: points
            });
        }

        // Baked ranges = only segments that actually produced a curve (P0.1).
        var bakedRanges = [];
        for (var s = 0; s < curveData.length; s++) {
            var cd = curveData[s];
            if (cd) bakedRanges.push([cd.segStart, cd.segEnd]);
        }

        // ===== READ ONCE: controls (points cached once for trimming) =====
        var controls = [];
        var numCtrl = noteGroup.getNumPitchControls();
        for (var c = 0; c < numCtrl; c++) {
            var pc = noteGroup.getPitchControl(c);
            if (!pc || typeof pc.getPosition !== "function") continue;
            var pos = pc.getPosition();
            var isCurve = (typeof pc.getPoints === "function");
            var pts = null, anchorRel = 0, cLo = pos, cHi = pos;
            if (isCurve) {
                pts = pc.getPoints();
                if (typeof pc.getPitch === "function") anchorRel = pc.getPitch();
                if (pts && pts.length > 0) {
                    cLo = pos + pts[0][0];
                    cHi = pos + pts[pts.length - 1][0];
                }
            }
            controls.push({ index: c, pos: pos, isCurve: isCurve, points: pts, anchorRel: anchorRel, lo: cLo, hi: cHi });
        }

        // ===== COMPUTE deletions + trims against bakedRanges only (P0.2) =====
        var toRemove = [];
        var trimAdditions = [];
        for (var c = 0; c < controls.length; c++) {
            var d = controls[c];
            if (!d.isCurve) {
                if (inRanges(d.pos, bakedRanges)) toRemove.push(d.index);
                continue;
            }
            if (!d.points || d.points.length === 0) continue;
            var keeps = keepIntervalsFor(d.lo, d.hi, bakedRanges);
            var untouched = (keeps.length === 1 && keeps[0][0] === d.lo && keeps[0][1] === d.hi);
            if (untouched) continue;
            toRemove.push(d.index);
            for (var k = 0; k < keeps.length; k++) {
                var a = keeps[k][0], b = keeps[k][1];
                if (b - a <= 0) continue;
                var newPts = [];
                if (a > d.lo) newPts.push([0, lerpValueAt(d.points, a - d.pos)]);
                for (var p = 0; p < d.points.length; p++) {
                    var absT = d.pos + d.points[p][0];
                    if (absT >= a && absT <= b) newPts.push([absT - a, d.points[p][1]]);
                }
                if (b < d.hi) newPts.push([b - a, lerpValueAt(d.points, b - d.pos)]);
                // enforce strictly increasing times
                var clean = [];
                for (var p = 0; p < newPts.length; p++) {
                    if (clean.length === 0 || newPts[p][0] > clean[clean.length - 1][0]) {
                        clean.push(newPts[p]);
                    }
                }
                if (clean.length >= 2) {
                    trimAdditions.push({ pos: a, pitch: d.anchorRel, points: clean });
                }
            }
        }

        // ===== WRITE ONCE =====
        toRemove.sort(function(a, b) { return b - a; });
        for (var r = 0; r < toRemove.length; r++) {
            noteGroup.removePitchControl(toRemove[r]);
        }
        for (var a = 0; a < trimAdditions.length; a++) {
            var ta = trimAdditions[a];
            var tc = SV.create("PitchControlCurve");
            tc.setPosition(ta.pos);
            tc.setPitch(ta.pitch);
            tc.setPoints(ta.points);
            noteGroup.addPitchControl(tc);
        }

        var skippedCount = 0;
        for (var s = 0; s < curveData.length; s++) {
            var cd = curveData[s];
            if (!cd) { skippedCount++; continue; }
            var curve = SV.create("PitchControlCurve");
            curve.setPosition(cd.segStart);
            curve.setPitch(cd.anchorRel);
            curve.setPoints(cd.points);
            noteGroup.addPitchControl(curve);
        }

        var msg = "Done! Pitch has been baked into curves.";
        if (skippedCount > 0) {
            msg += "\n\nSome sections could not be baked.\n" +
                   "Play the fragment and run the script again.";
        }
        msg += "\nYou can undo with Ctrl+Z.";
        SV.showMessageBox("BakedPitch", msg);
        SV.finish();
    }

    doSample();
}