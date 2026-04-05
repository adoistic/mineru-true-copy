import { checkHealth } from '@/lib/mineru/client';
import { getActiveJobs } from '@/lib/db/sqlite';

export async function GET() {
  try {
    const mineruUrl = process.env.MINERU_API_URL || 'http://127.0.0.1:8765';
    const response = await fetch(`${mineruUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const healthy = response.ok;

    let jobCount = 0;
    try {
      const jobs = getActiveJobs();
      jobCount = jobs.length;
    } catch {}

    return Response.json({
      mineru_status: healthy ? 'green' : 'red',
      active_jobs: jobCount,
    });
  } catch (e) {
    console.error('[status] health check failed:', (e as Error).message);
    return Response.json({
      mineru_status: 'red',
      active_jobs: 0,
    });
  }
}
