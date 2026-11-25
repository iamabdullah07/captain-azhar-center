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

export type EditableDocKind = 'pdf' | 'word';

export const EDITABLE_DOC_RULES = {
  accept:
    '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extensions: ['pdf', 'doc', 'docx'] as const,
  maxBytes: 25 * 1024 * 1024,
  maxLabel: '25 MB',
};

export function detectEditableDocKind(filename: string): EditableDocKind | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'word';
  return null;
}

export function validateEditableDocFile(
  file: File
): { ok: true; kind: EditableDocKind; ext: string } | { ok: false; error: string } {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const kind = detectEditableDocKind(file.name);
  if (!kind) {
    return {
      ok: false,
      error: 'Unsupported file type. Please choose a PDF, DOC, or DOCX document.',
    };
  }
  if (file.size <= 0) {
    return { ok: false, error: 'Selected file is empty.' };
  }
  if (file.size > EDITABLE_DOC_RULES.maxBytes) {
    return {
      ok: false,
      error: `Document exceeds the ${EDITABLE_DOC_RULES.maxLabel} maximum size limit.`,
    };
  }
  return { ok: true, kind, ext };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 10 || i === 0 ? val.toFixed(1) : val.toFixed(2)} ${units[i]}`;
}

export const EXTRACT_UPLOAD_RULES = {
  accept:
    '.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.zip,.doc,.docx,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,application/zip,application/x-zip-compressed,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'zip', 'docx', 'doc'] as const,
  imageExtensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'] as const,
  maxImageBytes: 20 * 1024 * 1024,
  maxDocBytes: 25 * 1024 * 1024,
} as const;

export function validateExtractFile(
  file: File,
  maxPdfMb = 50
): { ok: true; ext: string } | { ok: false; error: string } {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ext || !(EXTRACT_UPLOAD_RULES.extensions as readonly string[]).includes(ext)) {
    return {
      ok: false,
      error: `Unsupported file type "${file.name}". Allowed: JPG, JPEG, PNG, WEBP, HEIC, PDF, ZIP, DOCX.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, error: `"${file.name}" is empty.` };
  }

  const maxPdfBytes = Math.max(5, maxPdfMb) * 1024 * 1024;
  if ((EXTRACT_UPLOAD_RULES.imageExtensions as readonly string[]).includes(ext)) {
    if (file.size > EXTRACT_UPLOAD_RULES.maxImageBytes) {
      return { ok: false, error: `"${file.name}" exceeds the 20 MB image size limit.` };
    }
    return { ok: true, ext };
  }

  if (ext === 'doc' || ext === 'docx') {
    if (file.size > EXTRACT_UPLOAD_RULES.maxDocBytes) {
      return { ok: false, error: `"${file.name}" exceeds the 25 MB document size limit.` };
    }
    return { ok: true, ext };
  }

  if (file.size > maxPdfBytes) {
    return {
      ok: false,
      error: `"${file.name}" exceeds the configured ${maxPdfMb} MB limit.`,
    };
  }
  return { ok: true, ext };
}
