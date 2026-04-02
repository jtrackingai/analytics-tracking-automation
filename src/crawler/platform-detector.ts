import { Page } from 'playwright';

export type SitePlatformType = 'generic' | 'shopify';
export type PlatformConfidence = 'low' | 'medium' | 'high';

export interface SitePlatform {
  type: SitePlatformType;
  confidence: PlatformConfidence;
  signals: string[];
}

const CONFIDENCE_SCORE: Record<PlatformConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function makeGenericPlatform(): SitePlatform {
  return {
    type: 'generic',
    confidence: 'low',
    signals: [],
  };
}

export function isShopifyPlatform(platform: SitePlatform | undefined | null): boolean {
  return platform?.type === 'shopify';
}

export async function detectPlatformOnPage(page: Page): Promise<SitePlatform> {
  const detected = await page.evaluate(() => {
    const strongSignals: string[] = [];
    const weakSignals: string[] = [];

    if (window.location.hostname.endsWith('.myshopify.com')) {
      strongSignals.push('myshopify_domain');
    }

    if (typeof (window as any).Shopify === 'object') {
      strongSignals.push('window_shopify');
    }

    if ((window as any).Shopify?.theme || (window as any).Shopify?.routes) {
      strongSignals.push('shopify_globals');
    }

    if (document.querySelector(
      'script[src*="cdn.shopify.com"], script[src*="/cdn/shopify/"], ' +
      'link[href*="cdn.shopify.com"], link[href*="/cdn/shopify/"], ' +
      'img[src*="cdn.shopify.com"], img[src*="/cdn/shopify/"]',
    )) {
      strongSignals.push('shopify_assets');
    }

    if (document.querySelector(
      '[id^="shopify-section-"], .shopify-section, [data-shopify], [data-shopify-editor-section]',
    )) {
      strongSignals.push('shopify_section_markup');
    }

    if (/^\/(products|collections|cart)(\/|$)/i.test(window.location.pathname)) {
      weakSignals.push('shopify_storefront_path');
    }

    const hasShopifyStoreLinks = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 200)
      .some(link => {
        try {
          const href = (link as HTMLAnchorElement).href;
          return /\/(products|collections|cart)(\/|$)/i.test(new URL(href, window.location.href).pathname);
        } catch {
          return false;
        }
      });
    if (hasShopifyStoreLinks) {
      weakSignals.push('shopify_storefront_links');
    }

    const uniqueStrong = [...new Set(strongSignals)];
    const uniqueWeak = [...new Set(weakSignals)];
    const signals = [...uniqueStrong, ...uniqueWeak];

    if (uniqueStrong.length >= 2) {
      return {
        type: 'shopify' as const,
        confidence: 'high' as const,
        signals,
      };
    }

    if (uniqueStrong.length === 1) {
      return {
        type: 'shopify' as const,
        confidence: uniqueWeak.length > 0 ? 'high' as const : 'medium' as const,
        signals,
      };
    }

    if (uniqueWeak.length >= 2) {
      return {
        type: 'shopify' as const,
        confidence: 'low' as const,
        signals,
      };
    }

    return {
      type: 'generic' as const,
      confidence: 'low' as const,
      signals: [],
    };
  });

  return detected;
}

export function mergePlatformDetections(detections: SitePlatform[]): SitePlatform {
  const shopifyDetections = detections.filter(isShopifyPlatform);

  if (shopifyDetections.length === 0) {
    return makeGenericPlatform();
  }

  const signals = [...new Set(shopifyDetections.flatMap(d => d.signals))].sort();
  const confidence = shopifyDetections.reduce<PlatformConfidence>((best, current) => {
    return CONFIDENCE_SCORE[current.confidence] > CONFIDENCE_SCORE[best]
      ? current.confidence
      : best;
  }, 'low');

  return {
    type: 'shopify',
    confidence,
    signals,
  };
}
