const express = require('express');
const cors = require('cors');
const Fuse = require('fuse.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Load grades data
let gradesData = {};
let fuseIndex = null;

function loadGradesData() {
  const filePath = path.join(__dirname, 'grades.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  gradesData = JSON.parse(raw);

  // Build fuse index from all instructor names
  const instructors = new Set();
  for (const course of Object.values(gradesData)) {
    for (const instructor of Object.keys(course)) {
      instructors.add(instructor);
    }
  }

  fuseIndex = new Fuse([...instructors], {
    threshold: 0.4,
    includeScore: true
  });

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

// Find instructor using fuzzy search
function findInstructor(abbreviatedName) {
  if (!fuseIndex) return null;

  const parsed = parseAbbreviatedName(abbreviatedName);
  if (!parsed) return null;

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

  if (!instructor) {
    return res.status(400).json({ success: false, error: 'instructor parameter required' });
  }

  // Find instructor
  const matchedInstructor = findInstructor(instructor);
  if (!matchedInstructor) {
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

  // If no specific course or not found, try to find any course with this instructor
  if (!courseData) {
    for (const [courseName, instructors] of Object.entries(gradesData)) {
      if (instructors[matchedInstructor]) {
        // If no course specified, use first match
        // If course specified but not exact match, keep looking
        if (!normalizedCourse) {
          courseData = instructors[matchedInstructor];
          matchedCourse = courseName;
          break;
        }
      }
    }
  }

  if (!courseData || courseData.length === 0) {
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', courses: Object.keys(gradesData).length });
});

// Start server
loadGradesData();
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
