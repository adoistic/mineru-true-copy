import { execSync } from 'child_process';
import os from 'os';

export async function POST() {
  try {
    // Use osascript to show a native folder picker on macOS
    const defaultPath = os.homedir();
    const script = `osascript -e 'POSIX path of (choose folder with prompt "Select Output Folder" default location POSIX file "${defaultPath}")'`;

    const result = execSync(script, { timeout: 60000 }).toString().trim();

    if (result) {
      return Response.json({ path: result });
    }

    return Response.json({ path: null, cancelled: true });
  } catch {
    // User cancelled the dialog
    return Response.json({ path: null, cancelled: true });
  }
}
