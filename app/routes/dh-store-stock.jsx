import { authenticate } from "../shopify.server";

const STORE_NAMES = [
  "Burnside",
  "Glenelg",
  "Marion",
  "Tanunda",
];

const LOW_STOCK_THRESHOLD = 2;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function normalizeVariantId(value) {
  if (!value) return null;

  const cleanValue = String(value).trim();

  if (!cleanValue) return null;

  if (cleanValue.startsWith("gid://shopify/ProductVariant/")) {
    return cleanValue;
  }

  if (/^\d+$/.test(cleanValue)) {
    return `gid://shopify/ProductVariant/${cleanValue}`;
  }

  return null;
}

function getAvailableQuantity(quantities = []) {
  const availableQuantity = quantities.find(
    (quantity) => quantity.name === "available",
  );

  return availableQuantity?.quantity ?? 0;
}

function getStockStatus(quantity) {
  if (quantity <= 0) {
    return "out_of_stock";
  }

  if (quantity <= LOW_STOCK_THRESHOLD) {
    return "low_stock";
  }

  return "in_stock";
}

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.public.appProxy(request);

    if (!admin) {
      return jsonResponse(
        {
          ok: false,
          error: "App is not installed or the app proxy session is unavailable.",
        },
        401,
      );
    }

    const url = new URL(request.url);

    const variantId = normalizeVariantId(
      url.searchParams.get("variant_id"),
    );

    if (!variantId) {
      return jsonResponse(
        {
          ok: false,
          error: "A valid variant_id is required.",
        },
        400,
      );
    }

    const response = await admin.graphql(
      `#graphql
        query DhStoreStock($variantId: ID!) {
          productVariant(id: $variantId) {
            id
            title
            sku
            product {
              id
              title
            }
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 100) {
                nodes {
                  location {
                    id
                    name
                    isActive
                  }
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          variantId,
        },
      },
    );

    const result = await response.json();

    if (result.errors?.length) {
      console.error(
        "DH Store Stock GraphQL errors:",
        JSON.stringify(result.errors),
      );

      return jsonResponse(
        {
          ok: false,
          error: "Unable to retrieve store inventory.",
        },
        502,
      );
    }

    const variant = result.data?.productVariant;

    if (!variant) {
      return jsonResponse(
        {
          ok: false,
          error: "Variant not found.",
        },
        404,
      );
    }

    const inventoryLevels =
      variant.inventoryItem?.inventoryLevels?.nodes ?? [];

    const levelByStoreName = new Map();

    for (const level of inventoryLevels) {
      const locationName = level.location?.name?.trim();

      if (!locationName) continue;

      levelByStoreName.set(locationName.toLowerCase(), level);
    }

    const stores = STORE_NAMES.map((storeName) => {
      const level = levelByStoreName.get(storeName.toLowerCase());

      const available =
        level && level.location?.isActive !== false
          ? getAvailableQuantity(level.quantities)
          : 0;

      return {
        name: storeName,
        available: available > 0,
        status: getStockStatus(available),
      };
    });

    return jsonResponse({
      ok: true,
      variant: {
        id: variant.id,
        title: variant.title,
        sku: variant.sku || null,
        product_title: variant.product?.title || null,
      },
      stores,
    });
  } catch (error) {
    console.error("DH Store Stock endpoint error:", error);

    return jsonResponse(
      {
        ok: false,
        error: "Unable to retrieve store availability.",
      },
      500,
    );
  }
};