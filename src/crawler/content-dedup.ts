import { PageAnalysis } from './page-analyzer';
import { getSectionPrefix } from './url-utils';

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function computeContentSimilarity(a: PageAnalysis, b: PageAnalysis): number {
  const classSim = jaccardSimilarity(a.sectionClasses ?? [], b.sectionClasses ?? []);
  if (classSim >= 0.8) return 1.0;

  const suffix = (t: string) => t.includes('|') ? t.split('|').slice(1).join('|').trim() : '';
  const titleMatch = (suffix(a.title) && suffix(b.title) && suffix(a.title) === suffix(b.title)) ? 1 : 0;

  const aCount = a.elements.length;
  const bCount = b.elements.length;
  const countSim = aCount > 0 && bCount > 0
    ? Math.min(aCount, bCount) / Math.max(aCount, bCount)
    : 0;

  return titleMatch * 0.5 + countSim * 0.5;
}

export function removeContentDuplicates(pages: PageAnalysis[], threshold = 0.8): PageAnalysis[] {
  const kept: PageAnalysis[] = [];
  for (const page of pages) {
    const isDup = kept.some(existing => {
      if (getSectionPrefix(page.url) !== getSectionPrefix(existing.url)) return false;
      return computeContentSimilarity(page, existing) >= threshold;
    });
    if (!isDup) kept.push(page);
  }
  return kept;
}
