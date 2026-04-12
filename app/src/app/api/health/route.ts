import { checkHealth, getMineruStatus, getLastHealth } from '@/lib/mineru/client';

export async function GET() {
  try {
    const healthy = await checkHealth();
    const mineruStatus = getMineruStatus();
    const lastHealth = getLastHealth();

    return Response.json({
      status: healthy ? 'ok' : 'degraded',
      app: healthy,
      processing_engine: mineruStatus,
      cloud_available: lastHealth?.cloud_available ?? false,
      local_available: lastHealth?.local_available ?? false,
      modes: lastHealth?.modes ?? [],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      {
        status: 'error',
        message: error instanceof Error ? error.message : 'Health check failed',
        cloud_available: false,
        local_available: false,
      },
      { status: 503 }
    );
  }
}
