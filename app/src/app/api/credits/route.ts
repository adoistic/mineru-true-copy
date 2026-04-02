import { getBalance, getUsageLogs } from '@/lib/firebase/credits';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get('key_id');

    if (!keyId) {
      return Response.json(
        { error: 'Missing required query parameter: key_id' },
        { status: 400 }
      );
    }

    const [balance, usageLogs] = await Promise.all([
      getBalance(keyId),
      getUsageLogs(keyId),
    ]);

    return Response.json({ key_id: keyId, balance, usage: usageLogs });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to fetch credits',
      },
      { status: 500 }
    );
  }
}
