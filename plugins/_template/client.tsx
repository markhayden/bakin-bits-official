/** Browser entry loaded by Bakin after the manifest resolves this plugin. */
import { registerPlugin } from '@makinbakin/sdk'
import { templateRegistration } from './client-registration'

registerPlugin(templateRegistration)
