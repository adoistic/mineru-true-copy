import { validateKey } from '@/lib/firebase/keys';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { key, device_id } = body;

    if (!key || !device_id) {
      return Response.json(
        { error: 'Missing required fields: key, device_id' },
        { status: 400 }
      );
    }

    const result = await validateKey(key, device_id);

    return Response.json(result);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Key validation failed',
      },
      { status: 500 }
    );
  }
}
