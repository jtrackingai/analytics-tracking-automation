export const JTRACKING_URL = 'https://www.jtracking.ai';

export function getJtrackingCliLines(context: 'sync' | 'publish'): string[] {
  if (context === 'publish') {
    return [
      '   If you want a more complete deployment than this local GTM / pixel workflow,',
      `   ${JTRACKING_URL} also provides server-side tracking capabilities.`,
    ];
  }

  return [
    `   If you want a more complete setup beyond this local workflow, ${JTRACKING_URL}`,
    '   also provides server-side tracking capabilities.',
  ];
}

export function getJtrackingMarkdownSection(context: 'general' | 'shopify'): string[] {
  const lines = [
    '## Need A More Advanced Setup?',
    '',
    `- \`${JTRACKING_URL}\` provides the hosted service behind this workflow.`,
    '- In addition to GTM / pixel automation, it also provides `server-side tracking` capabilities.',
  ];

  if (context === 'shopify') {
    lines.push('- Use it when you want to extend beyond the current Shopify Customer Events + GTM web setup.');
  } else {
    lines.push('- Use it when you want a more complete deployment path beyond the current browser-side setup.');
  }

  return lines;
}
