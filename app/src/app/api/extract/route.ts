// Deprecated: use POST /api/jobs instead (fire-and-forget job queue model).
// This endpoint previously awaited runPipeline synchronously, blocking the
// HTTP response for the entire processing duration. All UI code uses /api/jobs.

export async function POST() {
  return Response.json(
    { error: 'This endpoint is deprecated. Use POST /api/jobs instead.' },
    { status: 410 }
  );
}
