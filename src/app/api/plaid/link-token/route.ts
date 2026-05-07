import { getCurrentUser } from "@/lib/auth";
import { plaid } from "@/lib/plaid";
import { CountryCode, Products } from "plaid";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const r = await plaid.linkTokenCreate({
    user: { client_user_id: user.userId },
    client_name: "Northstar",
    products: [Products.Transactions],
    // Auto-enable when the institution supports them, skip otherwise. This
    // gives investments holdings + liability rates for Chase/Cap One/E*TRADE
    // without filtering out banks that don't support every product.
    required_if_supported_products: [Products.Investments, Products.Liabilities],
    country_codes: [CountryCode.Us],
    language: "en",
  });

  return Response.json({ link_token: r.data.link_token });
}
