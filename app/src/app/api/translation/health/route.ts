export async function GET() {
  const url = process.env.TRANSLATION_API_URL || 'http://localhost:51823';
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return Response.json({ status: 'offline', ready: false }, { status: 503 });
    }
    const data = await res.json();
    return Response.json({
      status: 'ok',
      ready: Boolean(data.ready),
      model_loaded: Boolean(data.model_loaded),
      model_direction: data.model_direction ?? null,
      model_variant: data.model_variant ?? null,
      available: Boolean(data.available),
    });
  } catch {
    return Response.json({ status: 'offline', ready: false }, { status: 503 });
  }
}
