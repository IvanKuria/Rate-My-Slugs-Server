# Rate My Slugs Server

A Node.js server that hosts grade distribution data and provides an API for querying instructor and course grades.

## Features

- Query grade distributions by instructor and course
- Fuzzy search for instructor names
- Aggregated statistics across multiple terms
- GPA calculation from grade distributions

## Installation

```bash
npm install
```

## Usage

Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

The server runs on port 3001 by default (configurable via `PORT` environment variable).

## API Endpoints

### GET /api/grades

Query grade data for an instructor.

**Parameters:**
- `instructor` (required) - Instructor name in abbreviated format (e.g., "Tantalo,P.")
- `course` (optional) - Course code (e.g., "CSE 101")

**Response:**
```json
{
  "success": true,
  "matchedInstructor": "Patrick Tantalo",
  "course": "CSE 101",
  "distributions": [...],
  "aggregated": {
    "letterGrades": {...},
    "otherGrades": {...},
    "totalStudents": 150,
    "gpa": 3.45
  }
}
```

### GET /api/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "courses": 500
}
```

## Dependencies

- Express 5.x
- cors
- fuse.js (fuzzy search)

## Author

Ivan Kuria
