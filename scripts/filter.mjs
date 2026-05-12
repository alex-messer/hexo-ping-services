import { runPing } from '../lib/run.mjs';
import { resolveConfig } from '../lib/config.mjs';

export function registerFilter(hexo) {
  hexo.extend.filter.register('after_generate', async function () {
    const cfg = resolveConfig(this.config);
    if (!cfg.enabled || !cfg.runAfterGenerate) return;
    try {
      const result = await runPing(this, {});
      this.log.info(`hexo-ping-services: pinged ${result.plan.length} URL(s) post-generate.`);
    } catch (err) {
      this.log.warn(`hexo-ping-services (after_generate): ${err.message}`);
    }
  });
}

export default registerFilter;
