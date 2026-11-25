export type InputTab = 'link' | 'image' | 'document' | 'video';

export interface UploadRule {
  label: string;
  accept: string;
  extensions: string[];
  maxBytes: number;
  maxLabel: string;
}

export const UPLOAD_RULES: Record<Exclude<InputTab, 'link'>, UploadRule> = {
  image: {
    label: 'Image',
    accept: '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
    maxBytes: 10 * 1024 * 1024,
    maxLabel: '10 MB',
  },
  document: {
    label: 'Document',
    accept:
      '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
    maxBytes: 25 * 1024 * 1024,
    maxLabel: '25 MB',
  },
  video: {
    label: 'Video',
    accept: '.mp4,.webm,.mov,video/mp4,video/webm,video/quicktime',
    extensions: ['mp4', 'webm', 'mov'],
    maxBytes: 50 * 1024 * 1024,
    maxLabel: '50 MB',
  },
};

export function validateSelectedFile(
  file: File,
  category: Exclude<InputTab, 'link'>
): { ok: true } | { ok: false; error: string } {
  const rule = UPLOAD_RULES[category];
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'svg') {
    return { ok: false, error: 'SVG images are not allowed for security reasons.' };
  }
  if (!ext || !rule.extensions.includes(ext)) {
    return {
      ok: false,
      error: `Unsupported file type. Allowed ${rule.label.toLowerCase()} formats: ${rule.extensions
        .map((e) => e.toUpperCase())
        .join(', ')}.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, error: 'Selected file is empty.' };
  }
  if (file.size > rule.maxBytes) {
    return {
      ok: false,
      error: `${rule.label} exceeds the ${rule.maxLabel} maximum size limit.`,
    };
  }
  return { ok: true };
}

export function validateUrlInput(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'Please paste or enter a website URL.' };
  }
  if (trimmed.length > 2048) {
    return { ok: false, error: 'URL is too long (maximum 2,048 characters).' };
  }
  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    if (proto !== 'http:' && proto !== 'https:') {
      return { ok: false, error: 'Only http:// and https:// URLs are allowed.' };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: 'Please enter a complete URL (starting with https:// or http://).' };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 10 || i === 0 ? val.toFixed(1) : val.toFixed(2)} ${units[i]}`;
}
