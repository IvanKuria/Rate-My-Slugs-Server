const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const Fuse = require('fuse.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Cache-Control values. Grade data is static / slow-changing, so allow clients
// and any CDN/proxy to cache it aggressively. A weak ETag is added automatically
// by Express on res.json(), so conditional GETs (If-None-Match) return 304.
const CACHE_HIT = 'public, max-age=86400, stale-while-revalidate=604800'; // 1 day, serve-stale 7 days
const CACHE_MISS = 'public, max-age=3600'; // 1 hour for "not found" so the client recovers after data updates

// Render's free tier sits behind a reverse proxy, so trust the first proxy hop.
// This lets express-rate-limit read the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});

app.use(compression()); // gzip responses (grade JSON is large and very compressible)
app.use(limiter);
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Data + precomputed lookup structures (built once at boot, not per request)
// ---------------------------------------------------------------------------
let gradesData = {};
let fuseIndex = null;
// Lowercased surname -> [full instructor names] for O(1) exact-surname lookups.
let instructorsBySurname = new Map();
// Full instructor name -> [course codes] (insertion order) so the "any course
// for this instructor" fallback is O(1) instead of scanning every course.
let coursesByInstructor = new Map();
let isReady = false;

function loadGradesData() {
  const filePath = path.join(__dirname, 'grades.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  gradesData = JSON.parse(raw);

  const instructors = new Set();
  instructorsBySurname = new Map();
  coursesByInstructor = new Map();

  // Single pass over the dataset builds every index we need.
  for (const [courseName, courseInstructors] of Object.entries(gradesData)) {
    for (const instructor of Object.keys(courseInstructors)) {
      instructors.add(instructor);

      // Map by surname (last token of the full name) for the fast path.
      const surname = instructor.split(' ').pop().toLowerCase();
      let bySurname = instructorsBySurname.get(surname);
      if (!bySurname) {
        bySurname = [];
        instructorsBySurname.set(surname, bySurname);
      }
      if (!bySurname.includes(instructor)) bySurname.push(instructor);

      // Map instructor -> courses, preserving course insertion order so the
      // "first course found" fallback matches the previous scan behavior.
      let courses = coursesByInstructor.get(instructor);
      if (!courses) {
        courses = [];
        coursesByInstructor.set(instructor, courses);
      }
      courses.push(courseName);
    }
  }

  // Fuse is kept only as a fuzzy fallback (typos / non-exact surnames).
  fuseIndex = new Fuse([...instructors], {
    threshold: 0.4,
    includeScore: true
  });

  isReady = true;
  console.log(`Loaded ${Object.keys(gradesData).length} courses`);
  console.log(`Indexed ${instructors.size} instructors`);
}

// Parse term code to readable format
// 2198 -> Fall 2019, 2220 -> Winter 2022, 2248 -> Fall 2024
function parseTermCode(code) {
  const codeStr = String(code);
  const quarterDigit = codeStr.slice(-1);
  const yearDigits = codeStr.slice(0, -1);

  const quarters = { '8': 'Fall', '0': 'Winter', '2': 'Spring', '4': 'Summer' };
  const quarter = quarters[quarterDigit] || 'Unknown';

  // 219 -> 19 -> 2019, 224 -> 24 -> 2024
  const yearSuffix = parseInt(yearDigits.slice(-2), 10);
  const year = 2000 + yearSuffix;

  return { quarter, year, display: `${quarter} ${year}` };
}

// Parse abbreviated name: "Tantalo,P." -> { lastName: "Tantalo", firstInitial: "P" }
function parseAbbreviatedName(abbrev) {
  if (!abbrev) return null;

  const match = abbrev.match(/^(.+),\s*([A-Za-z])\.?/);
  if (!match) return null;

  return {
    lastName: match[1].trim(),
    firstInitial: match[2].toUpperCase()
  };
}

// Find instructor from an abbreviated "Lastname,F." name.
// Fast path: exact surname lookup in a precomputed Map (O(1), no Fuse scan).
// Fallback: Fuse fuzzy search for typos / surnames that aren't the last token.
function findInstructor(abbreviatedName) {
  if (!fuseIndex) return null;

  const parsed = parseAbbreviatedName(abbreviatedName);
  if (!parsed) return null;

  // Fast path: exact surname match, then confirm the first-name initial.
  const candidates = instructorsBySurname.get(parsed.lastName.toLowerCase());
  if (candidates) {
    for (const fullName of candidates) {
      const firstName = fullName.split(' ')[0];
      if (firstName.toUpperCase().startsWith(parsed.firstInitial)) {
        return fullName;
      }
    }
  }

  // Fallback: fuzzy search over all instructor names.
  const results = fuseIndex.search(parsed.lastName);

  // Find match where first name starts with the initial
  for (const result of results) {
    const fullName = result.item;
    const firstName = fullName.split(' ')[0];
    if (firstName.toUpperCase().startsWith(parsed.firstInitial)) {
      return fullName;
    }
  }

  // If no match with initial, return best match if score is good
  if (results.length > 0 && results[0].score < 0.3) {
    return results[0].item;
  }

  return null;
}

// Normalize course code for matching
function normalizeCourse(course) {
  if (!course) return null;
  return course.toUpperCase().replace(/\s+/g, ' ').trim();
}

// Calculate GPA from grade distribution
function calculateGPA(grades) {
  const gradePoints = {
    'A+': 4.0, 'A': 4.0, 'A-': 3.7,
    'B+': 3.3, 'B': 3.0, 'B-': 2.7,
    'C+': 2.3, 'C': 2.0, 'C-': 1.7,
    'D+': 1.3, 'D': 1.0, 'D-': 0.7,
    'F': 0.0
  };

  let totalPoints = 0;
  let totalStudents = 0;

  for (const [grade, count] of Object.entries(grades)) {
    if (gradePoints[grade] !== undefined && count > 0) {
      totalPoints += gradePoints[grade] * count;
      totalStudents += count;
    }
  }

  if (totalStudents === 0) return null;
  return Math.round((totalPoints / totalStudents) * 100) / 100;
}

// Get letter grades only (exclude P/NP/W/etc)
function getLetterGrades(grades) {
  const letterGrades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];
  const result = {};
  for (const grade of letterGrades) {
    result[grade] = grades[grade] || 0;
  }
  return result;
}

// Get other grades (P/NP/W/etc)
function getOtherGrades(grades) {
  const otherGrades = ['P', 'NP', 'S', 'U', 'I', 'W'];
  const result = {};
  for (const grade of otherGrades) {
    if (grades[grade] && grades[grade] > 0) {
      result[grade] = grades[grade];
    }
  }
  return result;
}

// Count total students
function countStudents(grades) {
  const gradeKeys = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'P', 'NP', 'S', 'U', 'I', 'W'];
  let total = 0;
  for (const key of gradeKeys) {
    total += grades[key] || 0;
  }
  return total;
}

// Aggregate multiple term entries
function aggregateGrades(entries) {
  const aggregated = {};
  const allGrades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'P', 'NP', 'S', 'U', 'I', 'W'];

  for (const grade of allGrades) {
    aggregated[grade] = 0;
  }

  for (const entry of entries) {
    for (const grade of allGrades) {
      aggregated[grade] += entry[grade] || 0;
    }
  }

  return aggregated;
}

// API endpoint
app.get('/api/grades', (req, res) => {
  const { instructor, course } = req.query;

  if (!instructor || typeof instructor !== 'string') {
    res.set('Cache-Control', 'no-store');
    return res.status(400).json({ success: false, error: 'instructor parameter required' });
  }

  // Find instructor
  const matchedInstructor = findInstructor(instructor);
  if (!matchedInstructor) {
    res.set('Cache-Control', CACHE_MISS);
    return res.json({ success: false, error: 'instructor_not_found' });
  }

  const normalizedCourse = normalizeCourse(course);

  // Find course data for this instructor
  let courseData = null;
  let matchedCourse = null;

  if (normalizedCourse && gradesData[normalizedCourse]) {
    courseData = gradesData[normalizedCourse][matchedInstructor];
    matchedCourse = normalizedCourse;
  }

  // If no specific course was requested, fall back to any course taught by this
  // instructor. Uses the precomputed map (O(1)) and keeps the previous "first
  // course found" semantics by relying on insertion-ordered course lists.
  if (!courseData && !normalizedCourse) {
    const courses = coursesByInstructor.get(matchedInstructor);
    if (courses && courses.length > 0) {
      matchedCourse = courses[0];
      courseData = gradesData[matchedCourse][matchedInstructor];
    }
  }

  if (!courseData || courseData.length === 0) {
    res.set('Cache-Control', CACHE_MISS);
    return res.json({
      success: false,
      error: 'no_grade_data',
      matchedInstructor
    });
  }

  // Process distributions by term
  // Aggregate entries with same term (multiple sections)
  const termMap = new Map();
  for (const entry of courseData) {
    const termKey = entry.term;
    if (!termMap.has(termKey)) {
      termMap.set(termKey, []);
    }
    termMap.get(termKey).push(entry);
  }

  const distributions = [];
  for (const [term, entries] of termMap) {
    const aggregated = entries.length > 1 ? aggregateGrades(entries) : entries[0];
    const termInfo = parseTermCode(term);

    distributions.push({
      term,
      termDisplay: termInfo.display,
      quarter: termInfo.quarter,
      year: termInfo.year,
      letterGrades: getLetterGrades(aggregated),
      otherGrades: getOtherGrades(aggregated),
      totalStudents: countStudents(aggregated),
      gpa: calculateGPA(aggregated)
    });
  }

  // Sort by term (most recent first)
  distributions.sort((a, b) => b.term - a.term);

  // Calculate overall aggregated stats
  const allEntries = courseData;
  const overallAggregated = aggregateGrades(allEntries);

  res.set('Cache-Control', CACHE_HIT);
  res.json({
    success: true,
    matchedInstructor,
    course: matchedCourse,
    distributions,
    aggregated: {
      letterGrades: getLetterGrades(overallAggregated),
      otherGrades: getOtherGrades(overallAggregated),
      totalStudents: countStudents(overallAggregated),
      gpa: calculateGPA(overallAggregated)
    }
  });
});

// Lightweight health/readiness check. Returns 200 quickly (no data work), so an
// external uptime pinger can hit it to keep the Render free-tier dyno warm and
// mitigate cold-start spin-down. Existing /api/health is preserved below.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'starting' });
});

// Health check (existing endpoint, preserved for backward compatibility)
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', courses: Object.keys(gradesData).length });
});

// JSON 404 for unknown routes (so clients never receive an HTML error page).
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'not_found' });
});

// Centralized error handler: always respond with JSON, never an HTML stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: 'internal_error' });
});

// Start server
loadGradesData();
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
