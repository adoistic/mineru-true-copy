import { exec } from 'child_process';

export async function POST(request: Request) {
  try {
    const { path: folderPath } = await request.json();
    if (!folderPath) {
      return Response.json({ error: 'Missing path' }, { status: 400 });
    }

    // macOS: open in Finder
    exec(`open "${folderPath}"`);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to open folder' },
      { status: 500 }
    );
  }
}
