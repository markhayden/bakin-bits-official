export function definePluginUiConformance(config) {
  return config
}

// The real SDK validates and scopes plugin CSS under its ownership root. The
// preview server only consumes `.css`, and plugin sources already carry their
// `[data-bakin-plugin]` scope, so the stub passes the sheet through untouched.
export function transformPluginCss({ css }) {
  return { css, diagnostics: [] }
}
