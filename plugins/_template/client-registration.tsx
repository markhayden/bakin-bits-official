import type { PluginRegistration } from '@makinbakin/sdk'
import { TemplatePage } from './components/template-page'
import { TemplateWidget } from './components/template-widget'

/** Export the production registration so the browser fixture tests real wiring. */
export const templateRegistration = {
  id: '_template',
  routes: { '/_template': TemplatePage },
  slots: { 'home-widget': TemplateWidget },
} satisfies PluginRegistration
