// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { passthroughImageService } from 'astro/config';

// Project page on GitHub Pages: the site lives under /mailriz, so every
// internal link needs that prefix. Moving to a domain of its own later means
// setting `site` to it, adding public/CNAME, and deleting `base`.
export default defineConfig({
  // No images to optimise here, so skip sharp entirely — it is a large
  // native dependency this site would never use.
  image: { service: passthroughImageService() },
  site: 'https://rizkirmdhnnn.github.io',
  base: '/mailriz',
  // Every page lives under a locale prefix, so the bare root would 404.
  // Send it to the default locale. The target needs `base` spelled out —
  // Astro applies base to the key but writes the value through verbatim.
  redirects: { '/': '/mailriz/en/' },
  integrations: [
    starlight({
      title: 'MailRiz',
      description:
        'Self-hosted, persistent email aliases running entirely on Cloudflare.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/rizkirmdhnnn/mailriz',
        },
      ],
      // English is the source of truth; Indonesian pages that do not exist yet
      // fall back to it with a "not translated" notice rather than 404ing, so
      // the translation can land page by page.
      defaultLocale: 'en',
      locales: {
        en: { label: 'English' },
        id: { label: 'Bahasa Indonesia', lang: 'id' },
      },
      sidebar: [
        {
          label: 'Getting started',
          translations: { id: 'Memulai' },
          items: [
            { slug: 'getting-started/what-is-mailriz' },
            { slug: 'getting-started/quick-start' },
            { slug: 'getting-started/cloudflare-token' },
          ],
        },
        {
          label: 'Using MailRiz',
          translations: { id: 'Penggunaan' },
          items: [
            { slug: 'guides/aliases' },
            { slug: 'guides/reading-mail' },
            { slug: 'guides/organising' },
          ],
        },
        {
          label: 'How it works',
          translations: { id: 'Cara kerja' },
          items: [
            { slug: 'internals/architecture' },
            { slug: 'internals/mail-pipeline' },
            { slug: 'internals/storage' },
            { slug: 'internals/auth' },
            { slug: 'internals/security' },
          ],
        },
        {
          label: 'Operating',
          translations: { id: 'Operasional' },
          items: [
            { slug: 'operations/updating' },
            { slug: 'operations/troubleshooting' },
            { slug: 'operations/destroying' },
          ],
        },
        {
          label: 'Reference',
          translations: { id: 'Referensi' },
          items: [
            { slug: 'reference/cli' },
            { slug: 'reference/configuration' },
            { slug: 'reference/limits' },
          ],
        },
      ],
    }),
  ],
});
