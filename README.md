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

Health check endpoint (reports number of loaded courses).

**Response:**
```json
{
  "status": "ok",
  "courses": 500
}
```

### GET /health

Lightweight readiness probe that returns `200` quickly with no data work
(`503` while the dataset is still loading at boot).

**Response:**
```json
{ "status": "ok" }
```

## Performance & caching

- Lookups are precomputed at boot: a surname → instructor map gives O(1)
  instructor resolution (Fuse.js is kept only as a fuzzy fallback), and an
  instructor → courses map makes the "any course" fallback O(1) instead of
  scanning every course.
- Responses are gzip-compressed (`compression` middleware).
- Grade responses set `Cache-Control: public, max-age=86400` and Express adds a
  weak `ETag`, so clients/CDNs can cache and conditional GETs return `304`.
- Unknown routes and errors always return JSON (never HTML stack traces).

### Cold starts (Render free tier)

Render's free tier spins the service down when idle, causing a slow first
request. This cannot be fixed from code, but pointing an external uptime pinger
(e.g. UptimeRobot, cron-job.org) at `GET /health` on a short interval keeps the
instance warm. The `/health` route is intentionally cheap so pinging it is free.

## Dependencies

- Express 5.x
- cors
- compression (gzip)
- express-rate-limit
- fuse.js (fuzzy search)

## Author

Ivan Kuria
