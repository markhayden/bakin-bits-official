export function cn(...args) {
  return args.filter(Boolean).join(' ')
}

export function formatAge(value) {
  return String(value)
}

export function formatSize(bytes) {
  return `${bytes} B`
}
