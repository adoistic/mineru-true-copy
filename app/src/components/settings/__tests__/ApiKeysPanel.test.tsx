// @vitest-environment jsdom
/**
 * Tests for ApiKeysPanel — the OpenRouter key management UI.
 *
 * Mocks @tauri-apps/plugin-store with an in-memory fake. Mocks `sonner` toast
 * because jsdom doesn't render the real Toaster.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── In-memory fake store, shared across the test module ─────────────────
const fakeStoreState = new Map<string, unknown>();
const setSpy = vi.fn(async (key: string, value: unknown) => {
  fakeStoreState.set(key, value);
});
const getSpy = vi.fn(async (key: string) => fakeStoreState.get(key));
const deleteSpy = vi.fn(async (key: string) => {
  return fakeStoreState.delete(key);
});
const saveSpy = vi.fn(async () => {});
const onKeyChangeSpy = vi.fn(async () => () => {});

vi.mock('@tauri-apps/plugin-store', () => {
  return {
    load: vi.fn(async () => ({
      get: getSpy,
      set: setSpy,
      delete: deleteSpy,
      save: saveSpy,
      onKeyChange: onKeyChangeSpy,
    })),
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
  Toaster: () => null,
}));

// Import AFTER mocks are set up
import ApiKeysPanel from '../ApiKeysPanel';

beforeEach(() => {
  fakeStoreState.clear();
  setSpy.mockClear();
  getSpy.mockClear();
  deleteSpy.mockClear();
  saveSpy.mockClear();
  onKeyChangeSpy.mockClear();
  cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ApiKeysPanel', () => {
  test('empty state hides save until at least 10 chars', async () => {
    render(<ApiKeysPanel />);

    // Wait for store load
    await waitFor(() => {
      expect(screen.getByLabelText('OpenRouter API key')).toBeTruthy();
    });

    const input = screen.getByLabelText('OpenRouter API key') as HTMLInputElement;
    const saveButton = screen.getByRole('button', { name: /save/i });

    // 9 chars → still disabled
    fireEvent.change(input, { target: { value: '123456789' } });
    expect(saveButton.hasAttribute('disabled')).toBe(true);

    // 10 chars → enabled
    fireEvent.change(input, { target: { value: '1234567890' } });
    expect(saveButton.hasAttribute('disabled')).toBe(false);
  });

  test('save persists key with whitespace stripped', async () => {
    const user = userEvent.setup();
    render(<ApiKeysPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText('OpenRouter API key')).toBeTruthy();
    });

    const input = screen.getByLabelText('OpenRouter API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  sk-or-v1-abcdefghij  ' } });

    const saveButton = screen.getByRole('button', { name: /save/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith('openrouter_api_key', 'sk-or-v1-abcdefghij');
    });
    expect(saveSpy).toHaveBeenCalled();
  });

  test('reload restores SET state with masked last-4 display', async () => {
    fakeStoreState.set('openrouter_api_key', 'sk-or-v1-abcdefghij1234cd34');

    render(<ApiKeysPanel />);

    // Wait for the SET state — masked display ends in cd34
    await waitFor(() => {
      const masked = screen.getByText(/cd34$/);
      expect(masked).toBeTruthy();
    });

    expect(screen.getByRole('button', { name: /edit/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
  });

  test('remove returns to UNSET', async () => {
    fakeStoreState.set('openrouter_api_key', 'sk-or-v1-abcdefghij1234cd34');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    render(<ApiKeysPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('openrouter_api_key');
    });

    // Back to UNSET — input should be present and empty
    await waitFor(() => {
      const input = screen.getByLabelText('OpenRouter API key') as HTMLInputElement;
      expect(input.value).toBe('');
    });

    confirmSpy.mockRestore();
  });

  test('whitespace-only input does not enable save', async () => {
    render(<ApiKeysPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText('OpenRouter API key')).toBeTruthy();
    });

    const input = screen.getByLabelText('OpenRouter API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '                    ' } }); // 20 spaces

    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton.hasAttribute('disabled')).toBe(true);
  });
});
