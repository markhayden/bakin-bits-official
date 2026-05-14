/**
 * Client entry — _template plugin.
 *
 * Side-effect module: `registerPlugin({ ... })` populates the browser-
 * global registry that the shell's PluginHost reads on mount. Nothing
 * exported from this file is read; the import side effect is the API.
 */
import { registerPlugin } from '@makinbakin/sdk'
import type { NavItem } from '@makinbakin/sdk'
import { TemplatePage } from './components/template-page'

const navItems: NavItem[] = [
  {
    id: '_template',
    label: 'Template',
    icon: 'Sparkles',
    href: '/_template',
    order: 200,
  },
]

registerPlugin({
  id: '_template',
  navItems,
  slots: {
    'page:/_template': TemplatePage,
  },
})
