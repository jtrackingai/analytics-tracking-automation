import { EventSchema } from '../generator/event-schema';

export interface ShopifyEventMapping {
  shopifyEventName: string;
  ga4EventName: string;
  description: string;
}

export interface ShopifyPixelArtifacts {
  pixelCode: string;
  installGuide: string;
  mappings: ShopifyEventMapping[];
}

const SUPPORTED_MAPPINGS: ShopifyEventMapping[] = [
  {
    shopifyEventName: 'product_viewed',
    ga4EventName: 'view_item',
    description: 'Product detail view',
  },
  {
    shopifyEventName: 'collection_viewed',
    ga4EventName: 'view_item_list',
    description: 'Collection or product list view',
  },
  {
    shopifyEventName: 'product_added_to_cart',
    ga4EventName: 'add_to_cart',
    description: 'Add to cart',
  },
  {
    shopifyEventName: 'product_removed_from_cart',
    ga4EventName: 'remove_from_cart',
    description: 'Remove from cart',
  },
  {
    shopifyEventName: 'cart_viewed',
    ga4EventName: 'view_cart',
    description: 'Cart view',
  },
  {
    shopifyEventName: 'checkout_started',
    ga4EventName: 'begin_checkout',
    description: 'Checkout started',
  },
  {
    shopifyEventName: 'checkout_address_info_submitted',
    ga4EventName: 'add_shipping_info',
    description: 'Shipping info submitted',
  },
  {
    shopifyEventName: 'payment_info_submitted',
    ga4EventName: 'add_payment_info',
    description: 'Payment info submitted',
  },
  {
    shopifyEventName: 'checkout_completed',
    ga4EventName: 'purchase',
    description: 'Order completed',
  },
  {
    shopifyEventName: 'search_submitted',
    ga4EventName: 'search_submit',
    description: 'Storefront search submitted',
  },
];

function pickMappings(schema?: EventSchema): ShopifyEventMapping[] {
  if (!schema) return SUPPORTED_MAPPINGS;

  const schemaEventNames = new Set(schema.events.map(event => event.eventName));
  const matched = SUPPORTED_MAPPINGS.filter(mapping => schemaEventNames.has(mapping.ga4EventName));
  return matched.length > 0 ? matched : SUPPORTED_MAPPINGS;
}

export function generateShopifyPixelArtifacts(
  gtmPublicId: string,
  siteUrl: string,
  schema?: EventSchema,
): ShopifyPixelArtifacts {
  const mappings = pickMappings(schema);
  const mappingEntries = Object.fromEntries(
    mappings.map(mapping => [mapping.shopifyEventName, mapping.ga4EventName]),
  );
  const explicitSubscriptions = mappings.map(mapping => `analytics.subscribe(${JSON.stringify(mapping.shopifyEventName)}, function(event) {
  try {
    if (handlers.${mapping.shopifyEventName}) {
      handlers.${mapping.shopifyEventName}(event);
    }
  } catch (error) {
    console.error('[event-tracking][Shopify Pixel] Failed to handle event:', ${JSON.stringify(mapping.shopifyEventName)}, error);
  }
});`).join('\n\n');

  const pixelCode = `const GTM_CONTAINER_ID = ${JSON.stringify(gtmPublicId)};
const SHOPIFY_EVENT_MAPPINGS = ${JSON.stringify(mappingEntries, null, 2)};

window.dataLayer = window.dataLayer || [];

(function(w, d, s, l, i) {
  if (w.google_tag_manager && w.google_tag_manager[i]) return;
  w[l] = w[l] || [];
  w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  var firstScript = d.getElementsByTagName(s)[0];
  var script = d.createElement(s);
  var dataLayerParam = l !== 'dataLayer' ? '&l=' + l : '';
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtm.js?id=' + i + dataLayerParam;
  firstScript.parentNode.insertBefore(script, firstScript);
})(window, document, 'script', 'dataLayer', GTM_CONTAINER_ID);

function compactObject(input) {
  var output = {};
  Object.keys(input).forEach(function(key) {
    var value = input[key];
    if (value === undefined || value === null) return;
    if (Array.isArray(value) && value.length === 0) return;
    output[key] = value;
  });
  return output;
}

function firstDefined() {
  for (var i = 0; i < arguments.length; i += 1) {
    if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') {
      return arguments[i];
    }
  }
  return undefined;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripGraphqlId(value) {
  if (typeof value !== 'string') return value;
  var parts = value.split('/');
  return parts[parts.length - 1] || value;
}

function normalizeLocation(event) {
  return firstDefined(
    event && event.context && event.context.document && event.context.document.location && event.context.document.location.href,
    event && event.context && event.context.window && event.context.window.location && event.context.window.location.href
  );
}

function normalizeTitle(event) {
  return firstDefined(
    event && event.context && event.context.document && event.context.document.title,
    event && event.context && event.context.document && event.context.document.location && event.context.document.location.pathname
  );
}

function normalizeReferrer(event) {
  return firstDefined(
    event && event.context && event.context.document && event.context.document.referrer
  );
}

function getCurrencyFromPrice(price) {
  return firstDefined(
    price && price.currencyCode,
    price && price.currency_code
  );
}

function getAmountFromPrice(price) {
  return toNumber(firstDefined(
    price && price.amount,
    price && price.value
  ));
}

function buildItemFromMerchandise(merchandise, extras) {
  if (!merchandise) return null;
  var product = merchandise.product || {};
  var item = compactObject({
    item_id: firstDefined(
      extras && extras.item_id,
      merchandise.sku,
      stripGraphqlId(merchandise.id),
      stripGraphqlId(product.id)
    ),
    item_name: firstDefined(
      extras && extras.item_name,
      product.title,
      merchandise.title
    ),
    item_brand: firstDefined(
      extras && extras.item_brand,
      product.vendor
    ),
    item_category: firstDefined(
      extras && extras.item_category,
      product.type
    ),
    item_variant: firstDefined(
      extras && extras.item_variant,
      merchandise.title
    ),
    item_list_id: extras && extras.item_list_id,
    item_list_name: extras && extras.item_list_name,
    price: firstDefined(
      extras && extras.price,
      getAmountFromPrice(merchandise.price)
    ),
    quantity: firstDefined(
      extras && extras.quantity,
      1
    ),
  });

  return Object.keys(item).length > 0 ? item : null;
}

function buildItemsFromCartLines(lines, extras) {
  if (!Array.isArray(lines)) return [];

  return lines.map(function(line) {
    var cost = line && line.cost ? line.cost : {};
    return buildItemFromMerchandise(line && (line.merchandise || line.variant), compactObject({
      quantity: toNumber(line && line.quantity),
      price: firstDefined(
        getAmountFromPrice(cost.totalAmount),
        getAmountFromPrice(cost.amountPerQuantity)
      ),
      item_list_id: extras && extras.item_list_id,
      item_list_name: extras && extras.item_list_name,
    }));
  }).filter(Boolean);
}

function buildItemsFromCheckoutLines(lines) {
  if (!Array.isArray(lines)) return [];

  return lines.map(function(line) {
    var variant = line && (line.variant || line.merchandise);
    var linePrice = firstDefined(
      getAmountFromPrice(line && line.price),
      getAmountFromPrice(line && line.finalLinePrice),
      getAmountFromPrice(line && line.discountedTotalPrice)
    );
    return buildItemFromMerchandise(variant, compactObject({
      quantity: toNumber(line && line.quantity),
      price: linePrice,
    }));
  }).filter(Boolean);
}

function buildItemsFromVariants(variants, extras) {
  if (!Array.isArray(variants)) return [];

  return variants.map(function(variant) {
    return buildItemFromMerchandise(variant, compactObject({
      quantity: 1,
      item_list_id: extras && extras.item_list_id,
      item_list_name: extras && extras.item_list_name,
    }));
  }).filter(Boolean);
}

function buildPurchasePayload(checkout) {
  if (!checkout) return {};

  var shippingLine = firstDefined(
    checkout.shippingLine,
    checkout.shipping_rate
  );

  var hasDiscountApplications = Array.isArray(checkout.discountApplications) && checkout.discountApplications.length > 0;
  var coupon = hasDiscountApplications ? firstDefined(
    checkout.discountApplications[0].title,
    checkout.discountApplications[0].code
  ) : undefined;

  return compactObject({
    currency: firstDefined(
      checkout.currencyCode,
      getCurrencyFromPrice(checkout.totalPrice),
      getCurrencyFromPrice(checkout.subtotalPrice)
    ),
    value: firstDefined(
      getAmountFromPrice(checkout.totalPrice),
      getAmountFromPrice(checkout.subtotalPrice)
    ),
    transaction_id: firstDefined(
      checkout.order && stripGraphqlId(checkout.order.id),
      checkout.order && checkout.order.name,
      checkout.token,
      stripGraphqlId(checkout.id)
    ),
    shipping: firstDefined(
      getAmountFromPrice(shippingLine && shippingLine.price),
      getAmountFromPrice(checkout.shippingPrice)
    ),
    tax: firstDefined(
      getAmountFromPrice(checkout.totalTax),
      getAmountFromPrice(checkout.taxLines && checkout.taxLines[0] && checkout.taxLines[0].price)
    ),
    coupon: coupon,
    items: buildItemsFromCheckoutLines(checkout.lineItems),
  });
}

function pushShopifyEvent(ga4EventName, shopifyEventName, event, payload) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(compactObject({
    event: ga4EventName,
    shopify_event_name: shopifyEventName,
    shopify_event_id: event && event.id,
    shopify_event_seq: event && event.seq,
    page_location: normalizeLocation(event),
    page_title: normalizeTitle(event),
    page_referrer: normalizeReferrer(event),
    ...payload,
  }));
}

var handlers = {
  product_viewed: function(event) {
    var variant = event && event.data && (event.data.productVariant || event.data.variant);
    var item = buildItemFromMerchandise(variant, {});
    pushShopifyEvent('view_item', 'product_viewed', event, compactObject({
      currency: getCurrencyFromPrice(variant && variant.price),
      value: getAmountFromPrice(variant && variant.price),
      items: item ? [item] : [],
    }));
  },
  collection_viewed: function(event) {
    var collection = event && event.data && event.data.collection;
    var productVariants = firstDefined(
      event && event.data && event.data.productVariants,
      collection && collection.productVariants,
      []
    );
    var variants = Array.isArray(productVariants) ? productVariants : [];
    var items = buildItemsFromCartLines(variants.map(function(variant) {
      return { merchandise: variant, quantity: 1 };
    }), {
      item_list_id: stripGraphqlId(collection && collection.id),
      item_list_name: collection && collection.title,
    });
    pushShopifyEvent('view_item_list', 'collection_viewed', event, compactObject({
      item_list_id: stripGraphqlId(collection && collection.id),
      item_list_name: collection && collection.title,
      items: items,
    }));
  },
  product_added_to_cart: function(event) {
    var cartLine = event && event.data && event.data.cartLine;
    var items = buildItemsFromCartLines(cartLine ? [cartLine] : []);
    pushShopifyEvent('add_to_cart', 'product_added_to_cart', event, compactObject({
      currency: firstDefined(
        getCurrencyFromPrice(cartLine && cartLine.cost && cartLine.cost.totalAmount),
        getCurrencyFromPrice(cartLine && cartLine.merchandise && cartLine.merchandise.price)
      ),
      value: firstDefined(
        getAmountFromPrice(cartLine && cartLine.cost && cartLine.cost.totalAmount),
        items[0] && items[0].price && items[0].quantity ? items[0].price * items[0].quantity : undefined
      ),
      items: items,
    }));
  },
  product_removed_from_cart: function(event) {
    var cartLine = event && event.data && event.data.cartLine;
    var items = buildItemsFromCartLines(cartLine ? [cartLine] : []);
    pushShopifyEvent('remove_from_cart', 'product_removed_from_cart', event, compactObject({
      currency: firstDefined(
        getCurrencyFromPrice(cartLine && cartLine.cost && cartLine.cost.totalAmount),
        getCurrencyFromPrice(cartLine && cartLine.merchandise && cartLine.merchandise.price)
      ),
      value: firstDefined(
        getAmountFromPrice(cartLine && cartLine.cost && cartLine.cost.totalAmount),
        items[0] && items[0].price && items[0].quantity ? items[0].price * items[0].quantity : undefined
      ),
      items: items,
    }));
  },
  cart_viewed: function(event) {
    var cart = event && event.data && event.data.cart;
    pushShopifyEvent('view_cart', 'cart_viewed', event, compactObject({
      currency: firstDefined(
        getCurrencyFromPrice(cart && cart.cost && cart.cost.totalAmount),
        getCurrencyFromPrice(cart && cart.totalPrice)
      ),
      value: firstDefined(
        getAmountFromPrice(cart && cart.cost && cart.cost.totalAmount),
        getAmountFromPrice(cart && cart.totalPrice)
      ),
      items: buildItemsFromCartLines(firstDefined(cart && cart.lines, cart && cart.lineItems, [])),
    }));
  },
  checkout_started: function(event) {
    var checkout = event && event.data && event.data.checkout;
    pushShopifyEvent('begin_checkout', 'checkout_started', event, compactObject({
      currency: firstDefined(
        checkout && checkout.currencyCode,
        getCurrencyFromPrice(checkout && checkout.totalPrice)
      ),
      value: firstDefined(
        getAmountFromPrice(checkout && checkout.totalPrice),
        getAmountFromPrice(checkout && checkout.subtotalPrice)
      ),
      items: buildItemsFromCheckoutLines(checkout && checkout.lineItems),
    }));
  },
  checkout_address_info_submitted: function(event) {
    var checkout = event && event.data && event.data.checkout;
    pushShopifyEvent('add_shipping_info', 'checkout_address_info_submitted', event, compactObject({
      currency: firstDefined(
        checkout && checkout.currencyCode,
        getCurrencyFromPrice(checkout && checkout.totalPrice)
      ),
      value: firstDefined(
        getAmountFromPrice(checkout && checkout.totalPrice),
        getAmountFromPrice(checkout && checkout.subtotalPrice)
      ),
      shipping_tier: firstDefined(
        checkout && checkout.shippingLine && checkout.shippingLine.title,
        checkout && checkout.delivery && checkout.delivery.title
      ),
      items: buildItemsFromCheckoutLines(checkout && checkout.lineItems),
    }));
  },
  payment_info_submitted: function(event) {
    var checkout = event && event.data && event.data.checkout;
    pushShopifyEvent('add_payment_info', 'payment_info_submitted', event, compactObject({
      currency: firstDefined(
        checkout && checkout.currencyCode,
        getCurrencyFromPrice(checkout && checkout.totalPrice)
      ),
      value: firstDefined(
        getAmountFromPrice(checkout && checkout.totalPrice),
        getAmountFromPrice(checkout && checkout.subtotalPrice)
      ),
      payment_type: firstDefined(
        event && event.data && event.data.paymentMethod && event.data.paymentMethod.name,
        checkout && checkout.paymentGateway
      ),
      items: buildItemsFromCheckoutLines(checkout && checkout.lineItems),
    }));
  },
  checkout_completed: function(event) {
    var checkout = event && event.data && event.data.checkout;
    pushShopifyEvent('purchase', 'checkout_completed', event, buildPurchasePayload(checkout));
  },
  search_submitted: function(event) {
    var searchResult = event && event.data && event.data.searchResult;
    var query = searchResult && searchResult.query;
    var productVariants = Array.isArray(searchResult && searchResult.productVariants) ? searchResult.productVariants : [];
    pushShopifyEvent('search_submit', 'search_submitted', event, compactObject({
      search_term: query,
      items: buildItemsFromVariants(productVariants, {
        item_list_name: 'Search Results',
      }),
      result_count: productVariants.length || undefined,
    }));
  },
};

${explicitSubscriptions}
`;

  const installGuide = [
    '# Shopify Custom Pixel Install Guide',
    '',
    `**Site:** ${siteUrl}`,
    `**GTM Container:** ${gtmPublicId}`,
    '',
    '## What This Pixel Does',
    '',
    '- Loads your GTM web container inside Shopify Customer Events',
    '- Subscribes to Shopify standard events',
    '- Pushes GA4-style ecommerce events into `dataLayer` for GTM to consume',
    '',
    '## Included Event Mapping',
    '',
    '| Shopify standard event | GA4 event sent to dataLayer | Purpose |',
    '|---|---|---|',
    ...mappings.map(mapping =>
      `| \`${mapping.shopifyEventName}\` | \`${mapping.ga4EventName}\` | ${mapping.description} |`,
    ),
    '',
    '## Choose Installation Mode',
    '',
    '### Mode A — Customer Events Custom Pixel Only',
    '',
    '- Recommended when you only need Shopify standard ecommerce events such as `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, and `search_submit`.',
    '- In this mode, GTM runs inside Shopify Customer Events sandbox, not in the storefront theme DOM.',
    '- If Tag Assistant or another preview tool says `Google Tag / GTM container not found` on the storefront page, that is expected in this mode.',
    '',
    '### Mode B — Optional Theme GTM Install',
    '',
    '- Use this in addition to Mode A when you want GTM to be detectable on storefront pages, or when you need theme-level pageview / click / form triggers.',
    '- Keep the Customer Events custom pixel installed even if you also install GTM in the theme. The theme snippet does not replace Shopify checkout and standard-event bridging.',
    '',
    '## Install Steps — Mode A',
    '',
    '1. Open Shopify Admin.',
    '2. Go to `Settings -> Customer events`.',
    '3. Click `Add custom pixel`.',
    '4. Paste the contents of `shopify-custom-pixel.js`.',
    '5. Save the pixel and click `Connect`.',
    '6. Publish your GTM workspace after the pixel is connected.',
    '',
    '## Optional Theme Install — Mode B',
    '',
    '1. Open Shopify Admin -> `Online Store -> Themes`.',
    '2. On the active theme, click `...` -> `Edit code`.',
    '3. Open `layout/theme.liquid`.',
    '4. Paste the head snippet immediately after the opening `<head>` tag.',
    '5. Paste the noscript snippet immediately after the opening `<body>` tag.',
    '6. Save the theme.',
    '',
    '### Theme Head Snippet',
    '',
    '```html',
    '<!-- Google Tag Manager -->',
    `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':`,
    `new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],`,
    `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=`,
    `'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);`,
    `})(window,document,'script','dataLayer','${gtmPublicId}');</script>`,
    '<!-- End Google Tag Manager -->',
    '```',
    '',
    '### Theme Body Snippet',
    '',
    '```html',
    '<!-- Google Tag Manager (noscript) -->',
    `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtmPublicId}"`,
    'height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>',
    '<!-- End Google Tag Manager (noscript) -->',
    '```',
    '',
    '## Validation',
    '',
    '1. Visit a product page, search, cart, and checkout flow on the storefront.',
    '2. Confirm events appear in GA4 Realtime.',
    '3. If you only installed Mode A, validate primarily with GA4 Realtime and Shopify pixel debugging tools.',
    '4. If you also installed Mode B, Tag Assistant / GTM Preview should be able to detect the container on storefront pages.',
    '',
    '## Notes',
    '',
    '- Shopify custom pixels run in a sandboxed environment. Prefer dataLayer-driven custom event triggers over DOM click triggers for ecommerce events.',
    '- If your schema includes Shopify ecommerce events, use `triggerType: "custom"` with GA4 event names such as `add_to_cart`, `begin_checkout`, `purchase`, and `search_submit`.',
    '- Theme GTM installation helps storefront preview and DOM-based triggers, but checkout-related Shopify standard events should still come from the Customer Events custom pixel bridge.',
  ].join('\n');

  return {
    pixelCode,
    installGuide,
    mappings,
  };
}
