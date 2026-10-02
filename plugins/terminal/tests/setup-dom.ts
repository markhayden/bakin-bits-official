import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Installed-package tests do not inherit the Bits root preload.
if (!globalThis.document) GlobalRegistrator.register()
