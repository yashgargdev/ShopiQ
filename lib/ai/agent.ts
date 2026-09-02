import 'server-only';

import { formatPrice, pluralise } from '@/lib/format';
import { getCatalogFacets, getProductDetail, listCategories } from '@/lib/products/queries';
import type { ProductSummary } from '@/types';

import { getSessionUser } from '@/lib/auth';
import {
  closeConfirmation,
  isConfirmationExpired,
  loadLiveConfirmation,
} from '@/lib/checkout/confirmation';

import { resolveProvider, type AIProvider } from './provider';
import {
  handleOrderStatusQuestion,
  handlePaymentStatusQuestion,
  handlePurchaseApproval,
  handlePurchaseDecline,
  handlePurchaseQuote,
} from './purchase-actions';
import {
  cartScopeLines,
  executeCartClear,
  handleCartAdd,
  handleCartClearRequest,
  handleCartRemove,
  handleCartUpdate,
  handleCartView,
  handleVariantAnswer,
  handleCheckout,
  handleCrossSell,
  toAgentCart,
  type CartTurnContext,
  type CartTurnResult,
} from './cart-actions';
import {
  loadPendingAction,
  readConfirmation,
  savePendingAction,
  type PendingAction,
} from './confirm';
import {
  handleAddressAdd,
  handleAddressList,
  handleOrderCancel,
  handleOrderList,
  handleOrderSelectionAnswer,
  handleOrderSupport,
  handleProfileUpdate,
  handleProfileView,
  readOrderSelection,
} from './account-actions';
import { handleSignInAnswer, readSignInState, startSignIn } from './signin-flow';
import { shouldCrossSell } from './crosssell';
import { answerWhyRecommended } from './why';
import { answerReviewQuestion } from './review-answers';
import { detectLanguage, localise } from './language';
import { coloursFor, readVariantSelection } from './variant-flow';
import { statedStorage, storageLabel, variantBase } from './variants';
import { extractOrdinals, type ReferenceScope } from './references';
import { extractRequirements, mergeRequirements } from './requirements/extract';
import { rankCandidates } from './recommend/engine';
import { providerToolDefinitions, runTool, ToolBudget, type ToolName } from './tools/registry';
import {
  compareProducts as runCompare,
  pickKeySpecs,
  searchProductSummaries,
} from './tools/implementations';
import type { ToolCart } from './tools/cart';
import type {
  AgentAction,
  AgentCartPayload,
  AgentIntent,
  AgentReply,
  ComparisonPayload,
  ConversationMessage,
  Recommendation,
  RecommendedProductPayload,
  ShoppingRequirements,
} from './types';

/**
 * The ShopiQ shopping agent.
 *
 * Flow, per Phase 2 §16:
 *
 *   message -> requirement extraction -> candidate search (tools)
 *           -> hard-constraint filter -> deterministic scoring
 *           -> ranked result -> AI writes the explanation
 *
 * The model is never asked to choose or rank a product, and every factual
 * claim in the reply is drawn from a value this file already read out of the
 * catalogue. When no provider is configured, templated prose replaces the
 * generated prose and everything else is identical.
 */

const MAX_CANDIDATES = 20;
const TOP_N = 3;

/**
 * Changing where an open quote ships to.
 *
 * Deliberately requires a delivery verb: a bare mention of a city while a
 * quote is open should not silently redirect the order.
 */
const CHANGE_ADDRESS =
  /\b(?:deliver|ship|send|bhej)\w*\s+(?:it\s+)?to\b|\b(?:different|another|other|new)\s+address\b|\bchange\s+(?:the\s+)?(?:delivery\s+)?address\b|\buse\s+(?:my\s+)?(?:home|office|work)\b/i;

export interface AgentContext {
  conversationId: string;
  history: ConversationMessage[];
  state: ShoppingRequirements;
  lastShownProductIds: string[];
  /** Full payloads for the last shown list, so superlatives can resolve. */
  lastShownProducts: RecommendedProductPayload[];
}

/**
 * Run a turn, then render the reply in the shopper's language.
 *
 * The language step wraps the whole agent rather than living inside it. Most
 * of what ShopiQ says is a deterministic English template — cart totals, order
 * status, payment outcomes — and those never pass through the prose writers,
 * so translating inside the prose writers would leave the majority of replies
 * stubbornly English. Wrapping the single entry point is the only place that
 * catches all of them.
 */
export async function runAgent(message: string, context: AgentContext): Promise<AgentReply> {
  const language = detectLanguage(message, context.state.language ?? null);

  const reply = await runAgentCore(message, {
    ...context,
    state: { ...context.state, language },
  });

  return {
    ...reply,
    message: await localise(resolveProvider(), reply.message, language),
    // Carry the choice forward, so a later "haan" stays in the same language.
    requirements: { ...reply.requirements, language },
  };
}

async function runAgentCore(message: string, context: AgentContext): Promise<AgentReply> {
  const provider = resolveProvider();
  const budget = new ToolBudget(10);
  const toolsUsed: string[] = [];

  // ------------------------------------------------------------ confirmation
  // A parked destructive action is answered before anything else. Only a clear
  // yes runs it; a clear no cancels; anything else drops the action and the
  // message is handled as a fresh request.
  const pending = await loadPendingAction(context.conversationId);

  // --------------------------------------------------------- sign-in answer
  // A sign-in in progress owns the next message: an email address, a name, or
  // a six-digit code are answers, not new shopping requests. Read first,
  // because a bare code would otherwise be classified as a budget.
  const signInState = readSignInState(pending);
  if (signInState) {
    const step = await handleSignInAnswer(message, signInState);

    if (step) {
      await savePendingAction(context.conversationId, step.result.pendingAction ?? null);

      // Signed in mid-turn — carry straight on to what they were doing rather
      // than making them ask for checkout a second time.
      if (step.signedIn && step.resume === 'checkout') {
        const cartContext = await buildCartContext(context, budget, toolsUsed, null);
        const quote = await handlePurchaseQuote(cartContext, message);
        return finishTurn(
          context,
          { ...quote, message: `${step.result.message} ${quote.message}` },
          {
            intent: 'checkout',
            requirements: context.state,
            toolsUsed,
            provider: provider.name,
            degraded: !provider.available,
          },
        );
      }

      return finishTurn(context, step.result, {
        intent: 'checkout',
        requirements: context.state,
        toolsUsed,
        provider: provider.name,
        degraded: !provider.available,
      });
    }

    // Not an answer — drop the sign-in rather than trapping them in it.
    await savePendingAction(context.conversationId, null);
  }

  // ------------------------------------------------------ which order answer
  // "SQ-2026-1062" is an answer to a question we asked, not a fresh enquiry.
  // Without this the cancellation was forgotten between turns and the order
  // number was reclassified as a status question — so the assistant reported
  // on an order it had just been asked to cancel, and cancelled nothing.
  const orderSelection = readOrderSelection(pending);
  if (orderSelection) {
    const answered = await handleOrderSelectionAnswer(message, orderSelection);

    // Cleared either way: answered, or abandoned because they moved on.
    await savePendingAction(context.conversationId, answered?.pendingAction ?? null);

    if (answered) {
      return finishTurn(context, answered, {
        intent: orderSelection.kind === 'cancel' ? 'order_cancel' : 'order_support',
        requirements: context.state,
        toolsUsed,
        provider: provider.name,
        degraded: !provider.available,
      });
    }
    // Not an answer — fall through and handle the message on its own terms.
  }

  // ---------------------------------------------------------- variant answer
  // A parked variant question is not a yes/no either, so it has to be read
  // before the confirmation logic gets hold of it — "512 GB" is an answer, and
  // putting it through readConfirmation() would score it as neither yes nor no
  // and throw the half-finished add away.
  const variantSelection = readVariantSelection(pending);
  if (variantSelection) {
    const cartContext = await buildCartContext(context, budget, toolsUsed, null);
    const answered = await handleVariantAnswer(message, variantSelection, cartContext);

    // Clear the parked question either way: answered, or abandoned because the
    // shopper moved on. Leaving it armed would apply their next unrelated
    // message to a choice they have stopped making.
    await savePendingAction(context.conversationId, answered?.pendingAction ?? null);

    if (answered) {
      return finishTurn(context, answered, {
        intent: 'cart_add',
        requirements: context.state,
        toolsUsed,
        provider: provider.name,
        degraded: !provider.available,
      });
    }
    // Not an answer — fall through and handle the message on its own terms.
  } else if (pending) {
    const answer = readConfirmation(message);

    if (answer === 'yes') {
      const cartContext = await buildCartContext(context, budget, toolsUsed, null);
      const result = await executeConfirmedAction(pending, cartContext);
      await savePendingAction(context.conversationId, null);
      return finishTurn(context, result, {
        intent: 'confirm',
        requirements: context.state,
        toolsUsed,
        provider: provider.name,
        degraded: !provider.available,
      });
    }

    if (answer === 'no') {
      await savePendingAction(context.conversationId, null);
      return finishTurn(
        context,
        {
          message: `No problem — I've left your cart as it is.`,
          outcome: 'cancelled',
          cart: null,
          checkout: null,
          products: [],
          actions: [{ type: 'view_cart' }],
          pendingAction: null,
        },
        {
          intent: 'confirm',
          requirements: context.state,
          toolsUsed,
          provider: provider.name,
          degraded: !provider.available,
        },
      );
    }

    // Not an answer — abandon the proposal rather than leaving it armed.
    await savePendingAction(context.conversationId, null);
  }

  // ------------------------------------------------- purchase confirmation
  // A quoted total waiting for approval. The STATE lives in the
  // purchase_confirmations row, not in the transcript — the message is only
  // consulted for yes/no, and only while such a row is actually open. That
  // ordering is what stops a stray "yes" three turns later authorizing a
  // charge nobody was asking about.
  const shopper = await getSessionUser();
  if (shopper) {
    const liveConfirmation = await loadLiveConfirmation(shopper.id);

    if (liveConfirmation && liveConfirmation.status === 'pending') {
      if (isConfirmationExpired(liveConfirmation)) {
        await closeConfirmation(liveConfirmation.id, 'expired', { customerId: shopper.id });
      } else {
        const answer = readConfirmation(message);

        if (answer === 'yes' || answer === 'no') {
          const cartContext = await buildCartContext(context, budget, toolsUsed, null);
          const result =
            answer === 'yes'
              ? await handlePurchaseApproval(cartContext, liveConfirmation.id)
              : await handlePurchaseDecline(cartContext);

          return finishTurn(context, result, {
            intent: 'confirm',
            requirements: context.state,
            toolsUsed,
            provider: provider.name,
            degraded: !provider.available,
          });
        }
        // "deliver to Office" is not a yes and not a no — it is a change to
        // one term of the quote. Re-quoting invalidates the open confirmation
        // and issues a new one bound to the new address, so what gets approved
        // is always what was last shown.
        if (CHANGE_ADDRESS.test(message)) {
          const cartContext = await buildCartContext(context, budget, toolsUsed, null);
          const requote = await handlePurchaseQuote(cartContext, message);
          return finishTurn(context, requote, {
            intent: 'checkout',
            requirements: context.state,
            toolsUsed,
            provider: provider.name,
            degraded: !provider.available,
          });
        }

        // Anything else: leave the quote open. It expires on its own, and the
        // cart hash catches any change made in the meantime.
      }
    }
  }

  // The vocabulary the extractor maps onto — always the live catalogue, so the
  // agent can never invent a category that does not exist.
  const [categories, facets] = await Promise.all([listCategories(), getCatalogFacets()]);
  const vocabulary = categories.map((category) => ({
    slug: category.slug,
    name: category.name,
  }));
  const knownBrands = facets.brands.map((brand) => brand.name);

  const extraction = await extractRequirements(
    message,
    {
      vocabulary,
      knownBrands,
      previous: context.state,
      lastShownProductIds: context.lastShownProductIds,
    },
    provider,
  );

  const requirements = mergeRequirements(
    context.state,
    extraction.requirements,
    extraction.isRefinement,
  );

  const degraded = !provider.available || extraction.deterministic;

  const base = {
    requirements,
    toolsUsed,
    provider: provider.name,
    degraded,
    cart: null as AgentCartPayload | null,
    checkout: null,
    pendingAction: null,
  };

  // ------------------------------------------------------------------- cart
  // Cart intents are handled deterministically end to end. The reference is
  // resolved in code against the list actually shown, the tool runs through
  // the registry, and the reply states what the backend did.
  const CART_INTENTS = new Set([
    'cart_view',
    'cart_add',
    'cart_remove',
    'cart_update',
    'cart_clear',
    'checkout',
    'cross_sell',
  ]);

  // -------------------------------------------------- payment / order Q&A
  // Answered straight from the database. The assistant never describes a
  // payment or an order from memory — that is how an agent ends up telling
  // someone a charge succeeded when it is still unverified.
  if (extraction.intent === 'payment_status') {
    const result = await handlePaymentStatusQuestion();
    return finishTurn(context, result, {
      intent: 'payment_status',
      requirements,
      toolsUsed,
      provider: provider.name,
      degraded: !provider.available,
    });
  }

  // ------------------------------------------------------------- account
  // The customer's own data. Routed before anything that searches the
  // catalogue, because these messages are full of words the product patterns
  // want — "change my PHONE number" is not a request for a phone.
  //
  // Identity comes from the session inside each handler. Nothing here accepts
  // a customer id, so there is no phrasing that reaches another account.
  const ACCOUNT_HANDLERS: Partial<Record<AgentIntent, () => Promise<CartTurnResult>>> = {
    profile_view: () => handleProfileView(),
    profile_update: () => handleProfileUpdate(message),
    address_list: () => handleAddressList(),
    address_add: () => handleAddressAdd(),
    order_list: () => handleOrderList(),
    order_cancel: () => handleOrderCancel(message),
    order_support: () => handleOrderSupport(message),
  };

  // ------------------------------------------------------ "what do reviews say?"
  // Before intent routing, for the same reason as the "why" answer below: the
  // extractor reads it as a fresh product search and goes hunting the catalogue
  // for something called "what reviews say".
  const reviewScope = {
    shown: context.lastShownProducts.map((product) => ({
      productId: product.productId,
      name: product.name,
      brand: product.brand,
      price: product.price,
      score: product.score,
      specs: product.keySpecs,
    })),
    cart: [],
  };

  const reviewAnswer = await answerReviewQuestion(message, reviewScope, context.lastShownProducts);
  if (reviewAnswer) {
    return finishTurn(context, reviewAnswer, {
      intent: 'product_question',
      requirements,
      toolsUsed,
      provider: provider.name,
      degraded: !provider.available,
    });
  }
  // ------------------------------------------------------- "why that one?"
  // Checked before intent routing because there is no `why` intent: the
  // extractor reads it as a fresh product question and searches the catalogue
  // again, which answers a different question than the one asked. The reasons
  // were recorded when the suggestion was made, so this is answered from them
  // rather than re-derived — or, worse, improvised.
  const whyAnswer = answerWhyRecommended(
    message,
    {
      shown: context.lastShownProducts.map((product) => ({
        productId: product.productId,
        name: product.name,
        brand: product.brand,
        price: product.price,
        score: product.score,
        specs: product.keySpecs,
      })),
      cart: [],
    },
    context.lastShownProducts,
  );

  if (whyAnswer) {
    return finishTurn(context, whyAnswer, {
      intent: 'product_question',
      requirements,
      toolsUsed,
      provider: provider.name,
      degraded: !provider.available,
    });
  }

  const accountHandler = ACCOUNT_HANDLERS[extraction.intent];
  if (accountHandler) {
    const result = await accountHandler();

    // Persist any question the handler parked — "which order should I cancel?"
    // is only a real question if the answer can find its way back to it.
    if (result.pendingAction) {
      await savePendingAction(context.conversationId, result.pendingAction);
    }

    return finishTurn(context, result, {
      intent: extraction.intent,
      requirements,
      toolsUsed,
      provider: provider.name,
      degraded: !provider.available,
    });
  }

  if (extraction.intent === 'order_status') {
    const result = await handleOrderStatusQuestion(message);
    return finishTurn(context, result, {
      intent: 'order_status',
      requirements,
      toolsUsed,
      provider: provider.name,
      degraded: !provider.available,
    });
  }

  if (CART_INTENTS.has(extraction.intent)) {
    const cartContext = await buildCartContext(
      context,
      budget,
      toolsUsed,
      requirements,
      extraction.referencedProductIds,
    );

    let result: CartTurnResult;

    switch (extraction.intent) {
      case 'cart_view':
        result = await handleCartView(cartContext);
        break;
      case 'cart_add':
        result = await handleCartAdd(message, cartContext);
        break;
      case 'cart_remove':
        result = await handleCartRemove(message, cartContext);
        break;
      case 'cart_update':
        result = await handleCartUpdate(message, cartContext);
        break;
      case 'cart_clear':
        result = await handleCartClearRequest(cartContext);
        break;
      case 'checkout':
        // A signed-in shopper saying "I'm ready to buy" gets an exact,
        // itemised total to approve. A guest gets the Phase 3 summary and a
        // link to the checkout page, because there is nobody to charge yet.
        // Signed out? Sign them in first.
        //
        // Guest checkout took the payment and created the account afterwards,
        // but never established a session — so the customer paid and was then
        // told they needed to sign in to see the order they had just bought.
        // Doing it first means the order has an owner from the moment it
        // exists, and their saved addresses are available to choose from.
        result = shopper
          ? await handlePurchaseQuote(cartContext, message)
          : startSignIn('checkout');
        break;
      default:
        result = await handleCrossSell(cartContext, await pickCrossSellAnchor(cartContext, context));
        break;
    }

    if (result.pendingAction) {
      await savePendingAction(context.conversationId, result.pendingAction);
    }

    // A successful add is a natural moment to offer an accessory — but only
    // once, and only when the shopper did not just ask for one.
    if (
      extraction.intent === 'cart_add' &&
      result.outcome === 'cart_updated' &&
      shouldCrossSell(message, { justAddedToCart: true }) &&
      budget.remaining >= 3
    ) {
      // Cross-sell against the cart as it is NOW, not as it was when this turn
      // began. `cartContext.scope.cart` was read before the add, so the item
      // just added is missing from it — and handleCrossSell's "never recommend
      // something already in the basket" rule was therefore checking a stale
      // list. The visible symptom: adding the suggested controller made the
      // very same response suggest that controller again.
      const afterAdd: CartTurnContext = result.cart
        ? { ...cartContext, scope: { ...cartContext.scope, cart: cartScopeLines(result.cart) } }
        : cartContext;

      const anchor = await pickCrossSellAnchor(afterAdd, context);
      if (anchor) {
        const suggestion = await handleCrossSell(afterAdd, anchor);
        if (suggestion.products.length > 0) {
          result = {
            ...result,
            message: `${result.message} ${suggestion.message}`,
            products: suggestion.products,
            actions: [...result.actions, ...suggestion.actions],
          };
        }
      }
    }

    return finishTurn(context, result, {
      intent: extraction.intent,
      requirements,
      toolsUsed,
      provider: provider.name,
      degraded,
    });
  }

  // ---------------------------------------------------------------- compare
  if (extraction.intent === 'compare') {
    let ids = pickComparisonTargets(extraction.referencedProductIds, context.lastShownProductIds);

    // Nothing on screen to point at — but the shopper may have named the two
    // products outright, which is the most natural way to ask and used to be
    // answered with "tell me which ones".
    if (ids.length < 2) {
      const named = await resolveNamedComparison(message);
      if (named.length >= 2) ids = named;
    }

    if (ids.length < 2) {
      return {
        ...base,
        intent: 'compare',
        outcome: 'clarify',
        message:
          "I need two products to compare. Tell me which ones — you can say \"compare the first and second\" after I've shown you some options.",
        products: [],
        comparison: null,
        actions: [],
      };
    }

    const result = await runTool('compare_products', { product_ids: ids }, {
      conversationId: context.conversationId,
      budget,
    });
    toolsUsed.push('compare_products');

    if (!result.ok) {
      return {
        ...base,
        intent: 'compare',
        outcome: 'error',
        message: "I couldn't load those products to compare them. Try again in a moment.",
        products: [],
        comparison: null,
        actions: [],
      };
    }

    const comparison = await buildComparisonPayload(ids, requirements);
    const prose = await writeComparisonProse(provider, comparison, message, context);

    return {
      ...base,
      intent: 'compare',
      outcome: 'answer',
      message: prose,
      products: comparison.products,
      comparison,
      actions: comparison.productIds.map((productId) => ({
        type: 'view_product' as const,
        productId,
      })),
    };
  }

  // ----------------------------------------------------------- availability
  if (extraction.intent === 'availability' && extraction.referencedProductIds.length > 0) {
    const productId = extraction.referencedProductIds[0];
    const result = await runTool('check_inventory', { product_id: productId }, {
      conversationId: context.conversationId,
      budget,
    });
    toolsUsed.push('check_inventory');

    if (result.ok) {
      const stock = result.output as { available: boolean; quantity: number };
      const detail = await runTool('get_product', { product_id: productId }, {
        conversationId: context.conversationId,
        budget,
      });
      const name =
        detail.ok && detail.output
          ? ((detail.output as { name: string }).name ?? 'That product')
          : 'That product';

      return {
        ...base,
        intent: 'availability',
        outcome: 'answer',
        message: stock.available
          ? `Yes — ${name} is in stock, with ${stock.quantity} ${pluralise(stock.quantity, 'unit')} available right now.`
          : `${name} is out of stock at the moment. I can suggest similar options that are available if you like.`,
        products: [],
        comparison: null,
        actions: [{ type: 'view_product', productId }],
      };
    }
  }

  // ------------------------------------------------------ browse categories
  if (extraction.intent === 'browse_categories') {
    const result = await runTool('get_categories', { include_parents: false }, {
      conversationId: context.conversationId,
      budget,
    });
    toolsUsed.push('get_categories');

    const list = result.ok
      ? (result.output as { categories: Array<{ name: string; product_count: number }> }).categories
      : [];

    // Only categories that actually contain something. An empty category is
    // not an option — offering "Shoes (0)" invites the shopper to ask for
    // shoes and be told there are none, and counting them makes the catalogue
    // sound three times larger than it is.
    const stocked = list
      .filter((category) => category.product_count > 0)
      .sort((a, b) => b.product_count - a.product_count);

    const top = stocked
      .slice(0, 8)
      .map((category) => `${category.name} (${category.product_count})`)
      .join(', ');

    return {
      ...base,
      intent: 'browse_categories',
      outcome: 'answer',
      message: top
        ? `ShopiQ currently stocks ${stocked.length} ${pluralise(stocked.length, 'category', 'categories')}: ${top}. Tell me what you're shopping for and roughly what you want to spend, and I'll narrow it down.`
        : "I couldn't load the catalogue just now. Please try again in a moment.",
      products: [],
      comparison: null,
      actions: [],
    };
  }

  // ---------------------------------------------------- open product question
  if (extraction.intent === 'product_question' && provider.available) {
    const answered = await answerWithTools(provider, message, context, budget, toolsUsed);
    if (answered) {
      return {
        ...base,
        intent: 'product_question',
        outcome: 'answer',
        message: answered,
        products: [],
        comparison: null,
        actions: extraction.referencedProductIds.map((productId) => ({
          type: 'view_product' as const,
          productId,
        })),
      };
    }
  }

  // ------------------------------------------------------------- smalltalk
  if (extraction.intent === 'smalltalk' && !requirements.categorySlug) {
    return {
      ...base,
      intent: 'smalltalk',
      outcome: 'clarify',
      message:
        "I'm ShopiQ's shopping assistant. Tell me what you're looking for and roughly what you want to spend — for example, \"a laptop for programming and gaming under ₹80,000\" — and I'll search the catalogue.",
      products: [],
      comparison: null,
      actions: [],
    };
  }

  // ------------------------------------------------------------- recommend
  if (!requirements.categorySlug && requirements.keywords.length === 0) {
    return {
      ...base,
      intent: extraction.intent,
      outcome: 'clarify',
      message:
        "I can help with that — what kind of product are you after, and what's your budget? For example: \"headphones under ₹5,000 for the gym\".",
      products: [],
      comparison: null,
      actions: [],
    };
  }

  // ------------------------------------------------- picking a shown variant
  // "256 GB", on its own, right after being shown the sizes of one phone, is an
  // answer — not a fresh search for anything with 256 GB in it. Treating it as
  // a search is how someone who asked for an iPhone 16 ends up being shown an
  // iPhone 17, so it is resolved against what is actually on screen first.
  const shownPick = pickShownVariant(message, context.lastShownProducts);
  if (shownPick) {
    const colours = await coloursFor(shownPick.productId);
    const colourNote =
      colours.length > 0 ? ` It comes in ${colours.length} colours: ${colours.join(', ')}.` : '';

    return {
      ...base,
      intent: 'refine',
      outcome: 'matches',
      message: `The ${shownPick.name} is ${formatPrice(shownPick.price)}.${colourNote} Say the word and I'll add it to your cart.`,
      products: [shownPick],
      comparison: null,
      actions: [{ type: 'view_product', productId: shownPick.productId }],
    };
  }

  const candidates = focusOnNamedModel(
    await findCandidates(requirements, context, budget, toolsUsed),
    requirements.keywords,
  );
  const outcome = rankCandidates(candidates, requirements, { limit: TOP_N });

  if (outcome.kind === 'empty') {
    // When a brand was asked for, the useful answer is whether we carry that
    // brand at all. "I couldn't find anything for gaming accessories" told a
    // shopper asking after a Xiaomi charger about a category they never
    // mentioned, inferred from one word, while leaving the actual reason —
    // ShopiQ stocks no Xiaomi — unsaid.
    const unstockedBrand = await firstUnstockedBrand([
      // What the shopper named but the catalogue filter dropped, first: it is
      // the specific thing they asked about.
      ...extraction.unstockedBrands,
      ...requirements.brands,
    ]);

    return {
      ...base,
      intent: 'recommend',
      outcome: 'empty',
      message: unstockedBrand
        ? `ShopiQ doesn't carry ${unstockedBrand} at all, so there's nothing I can show you there. Tell me what you need it for and I'll suggest what I do stock.`
        : buildEmptyMessage(requirements, message),
      products: [],
      comparison: null,
      actions: [{ type: 'refine', suggestion: 'Widen the budget or drop a requirement' }],
    };
  }

  const products = outcome.recommendations.map(toPayload);
  const prose = await writeRecommendationProse(provider, {
    message,
    requirements,
    outcome,
    context,
  });

  // Asking which size is only useful when the answer is the whole remaining
  // decision — i.e. when these results are one phone at several capacities.
  const sizeQuestion = variantFollowUp(products);

  const actions: AgentAction[] = [];
  if (products.length >= 2) {
    actions.push({ type: 'compare', productIds: [products[0].productId, products[1].productId] });
  }
  for (const product of products) {
    actions.push({ type: 'view_product', productId: product.productId });
  }

  return {
    ...base,
    intent: extraction.isRefinement ? 'refine' : 'recommend',
    outcome: outcome.kind === 'relaxed' ? 'relaxed' : 'matches',
    message: prose + sizeQuestion,
    products,
    comparison: null,
    actions,
  };
}

/**
 * Keep only the candidates whose name matches what the shopper actually named.
 *
 * Full-text search is deliberately generous — "iPhone 16" matches every iPhone,
 * because "iphone" is one of the terms. The ranker then scores an iPhone 17 and
 * an iPhone 16 identically, since nothing in budget, specs or rating tells them
 * apart, and price decides. That is how someone who asked for an iPhone 16 ends
 * up being recommended an iPhone 17.
 *
 * A named model is a hard constraint, not a preference. Narrowing is applied
 * progressively and never returns nothing: a keyword matching no product at all
 * is a bad keyword, not a reason to claim the catalogue is empty.
 */
function focusOnNamedModel(
  candidates: ProductSummary[],
  keywords: string[],
): ProductSummary[] {
  if (candidates.length <= 1 || keywords.length === 0) return candidates;

  const nameOf = (product: ProductSummary) =>
    `${product.brand} ${product.name}`.toLowerCase();

  // A model is named by a number: "16", "17", "s26", "a14". Descriptive words
  // are NOT model names, and this distinction is the whole safety of the
  // function — "gaming" appears in the TUF Gaming's name and in no other
  // laptop's, so treating it as an identifier would answer "a laptop for
  // programming and some gaming" with the single machine that has the word in
  // its title, hiding every MacBook in the catalogue.
  const modelTokens = keywords.filter((keyword) => /\d/.test(keyword));
  if (modelTokens.length === 0) return candidates;

  const matchesModel = (product: ProductSummary) =>
    modelTokens.every((token) => nameOf(product).includes(token));

  const byModel = candidates.filter(matchesModel);
  if (byModel.length === 0) return candidates;

  // Once a model number has been named we are clearly talking about a specific
  // product, so the remaining words may refine within it — "pro" separating an
  // iPhone 17 Pro from an iPhone 17. Only applied when it leaves something.
  const qualifiers = keywords.filter((keyword) => !/\d/.test(keyword));
  if (qualifiers.length > 0) {
    const refined = byModel.filter((product) =>
      qualifiers.every((keyword) => nameOf(product).includes(keyword)),
    );
    if (refined.length > 0) return refined;
  }

  return byModel;
}

/**
 * Is this message just a variant answer about something already on screen?
 *
 * Deliberately narrow. It fires only for short messages — "256 GB", "the 1 TB
 * one" — because a storage size inside a real sentence ("show me 512 GB
 * laptops under 90000") is a search constraint, not a pick. Getting that wrong
 * in the permissive direction would hijack ordinary searches.
 */
function pickShownVariant(
  message: string,
  shown: RecommendedProductPayload[],
): RecommendedProductPayload | null {
  const words = message.trim().split(/\s+/);
  if (words.length > 5 || shown.length < 2) return null;

  const options = shown
    .map((product) => ({ id: product.productId, label: storageLabel(product.name) }))
    .filter((option): option is { id: string; label: string } => option.label !== null);

  if (options.length < 2) return null;

  const chosen = statedStorage(message, options);
  return chosen ? (shown.find((product) => product.productId === chosen) ?? null) : null;
}

/**
 * When every recommendation is the same phone at different sizes, the useful
 * next sentence is "which size?" rather than a second paragraph about the
 * phone. The sizes and prices are the real ones already ranked above.
 */
function variantFollowUp(products: RecommendedProductPayload[]): string {
  if (products.length < 2) return '';

  const families = new Set(products.map((product) => variantBase(product.name)));
  if (families.size !== 1) return '';

  const sizes = products
    .map((product) => ({ label: storageLabel(product.name), price: product.price }))
    .filter((entry): entry is { label: string; price: number } => entry.label !== null);

  if (sizes.length !== products.length) return '';

  const list = sizes.map((entry) => `${entry.label} at ${formatPrice(entry.price)}`).join(', ');
  return ` It comes in ${list} — which size would you like?`;
}

// ----------------------------------------------------------- cart plumbing

/**
 * Build the scope a reference is resolved against: the products the shopper
 * was last shown, and what is currently in their cart.
 */
async function buildCartContext(
  context: AgentContext,
  budget: ToolBudget,
  toolsUsed: string[],
  requirements: ShoppingRequirements | null,
  modelPositions: string[] = [],
): Promise<CartTurnContext> {
  const cartResult = await runTool('get_cart', {}, {
    conversationId: context.conversationId,
    budget,
  });
  toolsUsed.push('get_cart');

  const cart = cartResult.ok ? toAgentCart(cartResult.output as ToolCart) : null;

  const scope: ReferenceScope = {
    shown: context.lastShownProducts.map((product) => ({
      productId: product.productId,
      name: product.name,
      brand: product.brand,
      price: product.price,
      score: product.score,
      specs: product.keySpecs,
    })),
    cart: cart ? cartScopeLines(cart) : [],
  };

  // The extractor hands back product ids for positions it recognised; convert
  // them to indices so the deterministic resolver can use them as a fallback.
  const positions = modelPositions
    .map((id) => context.lastShownProductIds.indexOf(id) + 1)
    .filter((position) => position > 0);

  return {
    conversationId: context.conversationId,
    budget,
    toolsUsed,
    scope,
    requirements: requirements ?? context.state,
    modelPositions: positions,
  };
}

/**
 * What the accessories should pair with: the most recently added cart line,
 * falling back to the top product the shopper was shown.
 */
async function pickCrossSellAnchor(
  cartContext: CartTurnContext,
  context: AgentContext,
): Promise<ProductSummary | null> {
  // Anchor on the most expensive thing in the basket, not the most recent.
  //
  // Accessories hang off the main purchase. Using the last line meant that as
  // soon as someone accepted a suggested ₹7,999 controller, the controller
  // became the anchor and the answer turned into "nothing pairs with the
  // DualSense" — the laptop that prompted the suggestion was forgotten the
  // moment the suggestion was taken.
  const dearest = cartContext.scope.cart.reduce<{ productId: string; price: number } | null>(
    (best, line) => (best === null || line.price > best.price ? line : best),
    null,
  );

  const candidateId =
    dearest?.productId ?? context.lastShownProducts[0]?.productId ?? null;

  if (!candidateId) return null;

  // The FULL catalogue row, not a summary rebuilt from the tool output.
  //
  // That rebuild set `specs: {}`, and compatibility is decided from specs: with
  // no display size on the anchor, a 13-inch sleeve was judged "unknown fit"
  // rather than too small, and offered for a 15.6-inch laptop. Reading the row
  // gives the engine the specs and catalog_metadata it needs to say no.
  try {
    return await getProductDetail(candidateId);
  } catch {
    return null;
  }
}

async function executeConfirmedAction(
  pending: PendingAction,
  cartContext: CartTurnContext,
): Promise<CartTurnResult> {
  if (pending.action === 'clear_cart') {
    return executeCartClear(cartContext);
  }

  // Unknown parked action: refuse rather than improvise. Phase 4 adds its own
  // cases here for order and payment confirmation.
  return {
    message: "That request has expired. Tell me again what you'd like to do.",
    outcome: 'cancelled',
    cart: null,
    checkout: null,
    products: [],
    actions: [],
    pendingAction: null,
  };
}

/** Assemble a cart/checkout turn into the reply shape the API returns. */
function finishTurn(
  _context: AgentContext,
  result: CartTurnResult,
  meta: {
    intent: AgentReply['intent'];
    requirements: ShoppingRequirements;
    toolsUsed: string[];
    provider: string;
    degraded: boolean;
  },
): AgentReply {
  return {
    message: result.message,
    products: result.products,
    comparison: null,
    actions: result.actions,
    intent: meta.intent,
    outcome: result.outcome,
    requirements: meta.requirements,
    toolsUsed: meta.toolsUsed,
    provider: meta.provider,
    degraded: meta.degraded,
    cart: result.cart,
    checkout: result.checkout,
    pendingAction: result.pendingAction
      ? { action: result.pendingAction.action, summary: result.pendingAction.summary }
      : null,
    purchase: result.purchase ?? null,
    payment: result.payment ?? null,
    order: result.order ?? null,
  };
}

// ------------------------------------------------------------------ candidates

/**
 * Fetch candidates through the tool layer.
 *
 * Note what is NOT pushed into the database query: the budget ceiling. We
 * deliberately search a little above it so the engine can tell the difference
 * between "nothing exists" and "nothing exists under your budget, but here are
 * three at ₹64,999" — the honest no-results behaviour Phase 2 §21 asks for.
 */
/**
 * A stated category sometimes under-covers what the shopper meant. Someone who
 * says "a laptop, and some gaming too" is not excluding the Gaming Laptops
 * shelf — they just used the everyday word. These pairs widen the search so
 * the right products can compete; the scorer still decides the order.
 */
/*
 * One-directional on purpose. Generic -> specific broadens ("a laptop, and
 * some gaming" should see the Gaming Laptops shelf). Specific -> generic must
 * NOT happen: someone who said "gaming laptop" has already been specific, and
 * widening it back would let integrated-graphics ultrabooks outrank the
 * machines they actually asked for.
 */
const USE_CASE_CATEGORY_EXPANSIONS: Record<string, Partial<Record<string, string>>> = {
  gaming: {
    laptops: 'gaming-laptops',
    headphones: 'gaming-headsets',
  },
};

function expandedCategories(requirements: ShoppingRequirements): string[] {
  if (!requirements.categorySlug) return [];
  const slugs = [requirements.categorySlug];

  for (const useCase of requirements.useCases) {
    const sibling = USE_CASE_CATEGORY_EXPANSIONS[useCase]?.[requirements.categorySlug];
    if (sibling && !slugs.includes(sibling)) slugs.push(sibling);
  }
  return slugs;
}

async function findCandidates(
  requirements: ShoppingRequirements,
  context: AgentContext,
  budget: ToolBudget,
  toolsUsed: string[],
): Promise<ProductSummary[]> {
  const hardSpecFilters: Record<string, string | number> = {};
  for (const constraint of requirements.specConstraints) {
    if (!constraint.hard) continue;
    if (constraint.op === 'gte') hardSpecFilters[`${constraint.key}_min`] = Number(constraint.value);
    else if (constraint.op === 'lte') hardSpecFilters[`${constraint.key}_max`] = Number(constraint.value);
    else hardSpecFilters[constraint.key] = String(constraint.value);
  }

  const baseInput = {
    query: requirements.keywords.length > 0 ? requirements.keywords.join(' ') : null,
    brand: requirements.brands.length > 0 ? requirements.brands : null,
    max_price: requirements.budget.max !== null ? Math.round(requirements.budget.max * 1.35) : null,
    min_price: requirements.budget.min,
    min_rating: requirements.minRating,
    filters: Object.keys(hardSpecFilters).length > 0 ? hardSpecFilters : null,
    in_stock_only: requirements.requireInStock,
    sort: 'relevance' as const,
    limit: MAX_CANDIDATES,
  };

  const categories = expandedCategories(requirements);
  const searchInputs =
    categories.length > 0
      ? categories.map((category) => ({ ...baseInput, category }))
      : [{ ...baseInput, category: null }];

  // Route the first call through the registry so it is validated and
  // audit-logged exactly like a model-initiated one.
  const gate = await runTool('search_products', searchInputs[0], {
    conversationId: context.conversationId,
    budget,
  });
  toolsUsed.push('search_products');
  if (!gate.ok) return [];

  const batches = await Promise.all(searchInputs.map((input) => searchProductSummaries(input)));
  const products = dedupeById(batches.flatMap((batch) => batch.products));

  if (products.length > 0) return products;

  // Nothing at all — retry once without the spec filters and brand so we can
  // show near misses rather than a dead end.
  if (Object.keys(hardSpecFilters).length > 0 || requirements.brands.length > 0) {
    const relaxedBatches = await Promise.all(
      searchInputs.map((input) => searchProductSummaries({ ...input, filters: null, brand: null })),
    );
    return dedupeById(relaxedBatches.flatMap((batch) => batch.products));
  }
  return [];
}

function dedupeById(products: ProductSummary[]): ProductSummary[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function pickComparisonTargets(referenced: string[], lastShown: string[]): string[] {
  if (referenced.length >= 2) return referenced.slice(0, 4);
  if (referenced.length === 1 && lastShown.length >= 2) {
    const other = lastShown.find((id) => id !== referenced[0]);
    return other ? [referenced[0], other] : [];
  }
  return lastShown.slice(0, 2);
}

/**
 * Resolve products the shopper named outright, for a comparison.
 *
 * "compare MacBook Pro M5 and M5 Pro" used to fail: comparison only understood
 * ordinals against a list already on screen, so naming two products directly —
 * the most obvious way to ask — was answered with "tell me which ones".
 *
 * The hard part is that the two names overlap. "MacBook Pro M5" is a prefix of
 * "MacBook Pro M5 Pro", so a naive search resolves both halves to the same
 * product and there is nothing to compare. Each fragment therefore keeps a
 * ranked list of candidates, and a fragment that would collide with one already
 * taken falls through to its next-best match.
 */
async function resolveNamedComparison(message: string): Promise<string[]> {
  const stripped = message
    .replace(/\b(compare|comparison|difference between|diff between|vs\.?|versus|between)\b/gi, ' ')
    .replace(/\b(the|and|or|both|these|those|two|please|for me|which|is better|better)\b/gi, ' ')
    .trim();

  // Split on the separators people use between two product names. The original
  // "and"/"vs" have been stripped above, so the remaining structure is spacing
  // and punctuation — which is why the split happens on the ORIGINAL message.
  const fragments = message
    .replace(/\b(compare|comparison|difference between|diff between|between|which is better)\b/gi, ' ')
    .split(/\s+(?:and|vs\.?|versus|or)\s+|,\s*/i)
    .map((part) => part.replace(/[^\p{L}\p{N}\s.+-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 2);

  if (fragments.length < 2) return [];

  const tokensOf = (text: string) =>
    text.toLowerCase().split(/\s+/).filter((token) => token.length >= 1);

  /** Candidates for one fragment, best match first. */
  const rankFragment = async (fragment: string) => {
    let found: ProductSummary[] = [];
    try {
      const result = await searchProductSummaries({
        query: fragment,
        category: null,
        brand: null,
        min_price: null,
        max_price: null,
        min_rating: null,
        filters: null,
        in_stock_only: false,
        sort: 'relevance',
        limit: 20,
      });
      found = result.products;
    } catch {
      return [];
    }

    const wanted = tokensOf(fragment);
    return found
      .map((product) => {
        const name = `${product.brand} ${product.name}`.toLowerCase();
        const matched = wanted.filter((token) => name.includes(token)).length;
        return { product, matched, length: product.name.length };
      })
      // Most of the named tokens present wins; among equals the shortest name,
      // so "MacBook Pro M5" beats "MacBook Pro M5 Pro Max" for the plain M5.
      .filter((entry) => entry.matched > 0)
      .sort((a, b) => b.matched - a.matched || a.length - b.length)
      .map((entry) => entry.product);
  };

  const ranked = await Promise.all(fragments.slice(0, 4).map(rankFragment));

  const chosen: string[] = [];
  for (const candidates of ranked) {
    const pick = candidates.find((product) => !chosen.includes(product.id));
    if (pick) chosen.push(pick.id);
  }

  return chosen.length >= 2 ? chosen.slice(0, 4) : [];
}

// ------------------------------------------------------------------ payloads

function toPayload(recommendation: Recommendation): RecommendedProductPayload {
  const { product } = recommendation;
  return {
    productId: product.id,
    name: product.name,
    brand: product.brand,
    slug: product.slug,
    price: product.price,
    compareAtPrice: product.compareAtPrice,
    currency: product.currency,
    rating: product.rating,
    reviewCount: product.reviewCount,
    image: product.image,
    available: product.availability.inStock,
    availableQuantity: product.availability.available,
    lowStock: product.availability.lowStock,
    score: recommendation.score,
    reason: recommendation.matchReasons[0] ?? 'Matches what you asked for',
    matchReasons: recommendation.matchReasons,
    limitations: recommendation.limitations,
    keySpecs: pickKeySpecs(product.specs as Record<string, unknown>, 4),
  };
}

async function buildComparisonPayload(
  productIds: string[],
  requirements: ShoppingRequirements,
): Promise<ComparisonPayload> {
  const raw = await runCompare({ product_ids: productIds });

  const summaries = await Promise.all(
    raw.products.map(async (product) => {
      const found = await searchProductSummaries({ query: product.name, limit: 5 });
      return found.products.find((candidate) => candidate.id === product.id) ?? null;
    }),
  );

  const products: RecommendedProductPayload[] = raw.products.map((product, index) => {
    const summary = summaries[index];
    if (!summary) {
      return {
        productId: product.id,
        name: product.name,
        brand: product.brand,
        slug: '',
        price: product.price,
        compareAtPrice: null,
        currency: product.currency,
        rating: product.rating,
        reviewCount: 0,
        image: null,
        available: product.available,
        availableQuantity: 0,
        lowStock: false,
        score: 0,
        reason: '',
        matchReasons: [],
        limitations: [],
        keySpecs: {},
      };
    }
    const scored = rankCandidates([summary], requirements, { limit: 1, allowRelaxation: true });
    const recommendation =
      scored.kind === 'empty' ? null : (scored.recommendations[0] ?? null);
    return recommendation
      ? toPayload(recommendation)
      : {
          productId: summary.id,
          name: summary.name,
          brand: summary.brand,
          slug: summary.slug,
          price: summary.price,
          compareAtPrice: summary.compareAtPrice,
          currency: summary.currency,
          rating: summary.rating,
          reviewCount: summary.reviewCount,
          image: summary.image,
          available: summary.availability.inStock,
          availableQuantity: summary.availability.available,
          lowStock: summary.availability.lowStock,
          score: 0,
          reason: '',
          matchReasons: [],
          limitations: [],
          keySpecs: pickKeySpecs(summary.specs as Record<string, unknown>, 4),
        };
  });

  const rows = Object.entries(raw.comparison).map(([key, row]) => ({
    key,
    label: row.label,
    values: row.values,
    winner: row.winner,
    higherIsBetter: row.higher_is_better,
  }));

  // Deterministic tally — no model involved in deciding who "wins".
  const wins = new Array(products.length).fill(0);
  for (const row of rows) {
    if (row.winner !== null) wins[row.winner] += 1;
  }
  const decided = rows.filter((row) => row.winner !== null).length;
  const best = wins.indexOf(Math.max(...wins));
  const summary =
    decided === 0
      ? 'These two are closely matched on the specifications ShopiQ tracks.'
      : `${products[best]?.name ?? 'One option'} leads on ${wins[best]} of ${decided} measurable attributes.`;

  return { productIds: raw.products.map((product) => product.id), products, rows, summary };
}

// -------------------------------------------------------------------- prose

const NO_HALLUCINATION_RULES = [
  'You are ShopiQ, a shopping assistant for an Indian e-commerce store.',
  '',
  'Absolute rules:',
  '- Use ONLY the product facts given to you below. Never invent a product, price, discount, specification, rating, review count, or stock figure.',
  '- If a fact is not in the data provided, say you do not have it in the catalogue. Never guess.',
  '- The ranking has already been decided by ShopiQ. Explain it; do not re-rank, and do not suggest products that are not listed.',
  '- Mention the limitations you are given. Being honest about a drawback is more useful than overselling.',
  '- Prices are in Indian rupees. Write them as ₹79,999.',
  '- Reply to the customer in whatever language they used (English, Hindi, or Hinglish). Keep it to 2-4 sentences, warm and plain. No bullet lists, no markdown headings.',
  '',
  // Tone. Warmth here means taking the person seriously, not performing
  // enthusiasm: a shopper spending ₹80,000 wants to feel understood, and
  // "Great choice!!" on every product tells them nothing and reads as sales
  // patter. None of this licenses a claim that is not in the data above.
  'How to sound:',
  '- Talk like a knowledgeable person in a shop, not a brochure. Short sentences. No exclamation marks, no "Great choice!", no emoji.',
  '- Acknowledge what they actually said before answering it — especially a budget, a constraint, or a worry.',
  '- If they seem unsure, say what you would look at to decide, and offer the next step rather than pressing for the sale.',
  '- If the honest answer is that nothing fits, say so plainly. Never fill the gap with the closest thing and hope.',
  '- Refer back to what has already been discussed instead of restating it. They were there for it.',
].join('\n');

async function writeRecommendationProse(
  provider: AIProvider,
  input: {
    message: string;
    requirements: ShoppingRequirements;
    outcome: Extract<ReturnType<typeof rankCandidates>, { kind: 'matches' | 'relaxed' }>;
    context: AgentContext;
  },
): Promise<string> {
  const fallback = buildTemplatedRecommendation(input.outcome, input.requirements);
  if (!provider.available) return fallback;

  const facts = input.outcome.recommendations
    .map((recommendation, index) => {
      const { product } = recommendation;
      const specs = Object.entries(pickKeySpecs(product.specs as Record<string, unknown>, 6))
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      return [
        // Catalogue names already lead with the brand, so pairing them here
        // taught the model to write "the Apple Apple iPhone 16".
        `${index + 1}. ${displayName(product)}`,
        `   price: ${formatPrice(product.price)}${product.compareAtPrice ? ` (was ${formatPrice(product.compareAtPrice)})` : ''}`,
        `   rating: ${product.rating} from ${product.reviewCount} reviews`,
        `   stock: ${product.availability.inStock ? `${product.availability.available} available` : 'OUT OF STOCK'}`,
        `   specs: ${specs || 'none recorded'}`,
        `   match score: ${recommendation.score}/100`,
        `   why it matches: ${recommendation.matchReasons.join('; ') || 'general fit'}`,
        `   drawbacks: ${recommendation.limitations.join('; ') || 'none recorded'}`,
      ].join('\n');
    })
    .join('\n');

  const constraintSummary = describeRequirements(input.requirements);

  const situation =
    input.outcome.kind === 'relaxed'
      ? `IMPORTANT: nothing in the catalogue met every requirement. These are the closest options, found by relaxing ${input.outcome.relaxed.join(' and ')}. You MUST say clearly that you could not find an exact match before presenting them.`
      : `These products all satisfy the customer's stated requirements.`;

  try {
    const result = await provider.generateResponse({
      system: NO_HALLUCINATION_RULES,
      messages: [
        ...historyForModel(input.context.history),
        {
          role: 'user',
          content: [
            `Customer just said: """${input.message}"""`,
            '',
            `What ShopiQ understands they want: ${constraintSummary}`,
            '',
            situation,
            '',
            `ShopiQ searched ${input.outcome.considered} matching products and ranked these ${input.outcome.recommendations.length}:`,
            facts,
            '',
            'Write the reply. Lead with the top pick and one concrete reason from its data. Mention a real drawback if one is listed. Do not list every product in detail — the customer sees cards below your message.',
          ].join('\n'),
        },
      ],
      effort: 'low',
      maxTokens: 500,
    });

    return result.text.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function writeComparisonProse(
  provider: AIProvider,
  comparison: ComparisonPayload,
  message: string,
  context: AgentContext,
): Promise<string> {
  const fallback = buildTemplatedComparison(comparison);
  if (!provider.available) return fallback;

  const table = comparison.rows
    .map((row) => {
      const values = row.values
        .map((value, index) => `${comparison.products[index]?.name ?? index}: ${value ?? 'not listed'}`)
        .join(' | ');
      const winner =
        row.winner !== null ? ` (better: ${comparison.products[row.winner]?.name})` : '';
      return `- ${row.label}: ${values}${winner}`;
    })
    .join('\n');

  try {
    const result = await provider.generateResponse({
      system: NO_HALLUCINATION_RULES,
      messages: [
        ...historyForModel(context.history),
        {
          role: 'user',
          content: [
            `Customer just said: """${message}"""`,
            '',
            `Comparison of ${comparison.products.map((product) => product.name).join(' vs ')}, using real catalogue values:`,
            table,
            '',
            `ShopiQ's tally: ${comparison.summary}`,
            '',
            'Write 2-4 sentences explaining the practical difference and who each one suits. The full table is shown below your message, so do not repeat every row.',
          ].join('\n'),
        },
      ],
      effort: 'low',
      maxTokens: 450,
    });
    return result.text.trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Open-ended factual question, answered through a bounded tool loop.
 * Returns null when the provider cannot do it, so the caller falls through to
 * the deterministic recommendation path.
 */
async function answerWithTools(
  provider: AIProvider,
  message: string,
  context: AgentContext,
  budget: ToolBudget,
  toolsUsed: string[],
): Promise<string | null> {
  const allowed: ToolName[] = [
    'search_products',
    'get_product',
    'check_inventory',
    'get_related_products',
    'get_categories',
  ];

  try {
    const result = await provider.executeToolCalls({
      system: [
        NO_HALLUCINATION_RULES,
        '',
        'Answer the question by calling the tools available to you. Every fact in your answer must come from a tool result.',
        'If the tools do not have the information, say: "I don\'t have that information in the current catalogue."',
      ].join('\n'),
      messages: [
        ...historyForModel(context.history),
        { role: 'user', content: message },
      ],
      tools: providerToolDefinitions(allowed),
      maxIterations: 3,
      effort: 'low',
      execute: async (name, input) => {
        const outcome = await runTool(name, input, {
          conversationId: context.conversationId,
          budget,
        });
        if (!outcome.ok) return { error: outcome.error };
        toolsUsed.push(outcome.tool);
        return outcome.output;
      },
    });

    return result.text.trim() || null;
  } catch {
    return null;
  }
}

function historyForModel(
  history: ConversationMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .slice(-6)
    .map((entry) => ({
      role: entry.role as 'user' | 'assistant',
      content: entry.content.slice(0, 1500),
    }));
}

// --------------------------------------------------------- templated fallback

function describeRequirements(requirements: ShoppingRequirements): string {
  const parts: string[] = [];
  if (requirements.category) parts.push(`category: ${requirements.category}`);
  if (requirements.budget.max !== null) {
    parts.push(`budget up to ${formatPrice(requirements.budget.max)}`);
  }
  if (requirements.useCases.length > 0) {
    parts.push(`for ${requirements.useCases.map((useCase) => useCase.replace(/_/g, ' ')).join(' and ')}`);
  }
  for (const constraint of requirements.specConstraints) {
    const operator = constraint.op === 'gte' ? '≥' : constraint.op === 'lte' ? '≤' : '=';
    parts.push(`${constraint.key.replace(/_/g, ' ')} ${operator} ${constraint.value}`);
  }
  if (Object.keys(requirements.preferences).length > 0) {
    parts.push(`prefers ${Object.keys(requirements.preferences).join(', ').replace(/_/g, ' ')}`);
  }
  if (requirements.requireInStock) parts.push('must be in stock');
  return parts.length > 0 ? parts.join('; ') : 'nothing specific stated yet';
}

/**
 * Used whenever the model is unavailable. Every sentence is assembled from
 * catalogue values, so the degraded reply is still factually grounded — just
 * less fluent.
 */
function buildTemplatedRecommendation(
  outcome: Extract<ReturnType<typeof rankCandidates>, { kind: 'matches' | 'relaxed' }>,
  requirements: ShoppingRequirements,
): string {
  const top = outcome.recommendations[0];
  const count = outcome.recommendations.length;

  const opening =
    outcome.kind === 'relaxed'
      ? `I couldn't find anything matching all of your requirements${
          requirements.budget.max !== null ? ` under ${formatPrice(requirements.budget.max)}` : ''
        }. Here ${count === 1 ? 'is the closest option' : `are the ${count} closest options`}, after relaxing ${outcome.relaxed.join(' and ')}.`
      : `I found ${outcome.considered} ${pluralise(outcome.considered, 'product')} matching your requirements. Here ${count === 1 ? 'is my top pick' : `are my top ${count}`}.`;

  const pick = `My top pick is the ${displayName(top.product)} at ${formatPrice(top.product.price)} — ${top.matchReasons.slice(0, 2).join(', ') || 'it fits what you described'}.`;

  const caveat =
    top.limitations.length > 0 ? ` One thing to note: ${top.limitations[0]}.` : '';

  return `${opening} ${pick}${caveat}`;
}

/**
 * How a product should be named in prose.
 *
 * Most catalogue names already start with the brand — "Samsung Galaxy S25",
 * "Apple iPhone 16" — so prefixing the brand produced "the Apple Apple iPhone
 * 16", both in the templated replies and, worse, in the model's, because the
 * candidate list it was handed was written that way.
 */
function displayName(product: { brand: string; name: string }): string {
  return product.name.toLowerCase().startsWith(product.brand.toLowerCase())
    ? product.name
    : `${product.brand} ${product.name}`;
}

function buildTemplatedComparison(comparison: ComparisonPayload): string {
  const names = comparison.products.map((product) => product.name);
  const priceRow = comparison.rows.find((row) => row.key === 'price');

  let priceLine = '';
  if (priceRow && typeof priceRow.values[0] === 'number' && typeof priceRow.values[1] === 'number') {
    const difference = Math.abs(Number(priceRow.values[0]) - Number(priceRow.values[1]));
    const cheaper = Number(priceRow.values[0]) < Number(priceRow.values[1]) ? names[0] : names[1];
    if (difference > 0) {
      priceLine = ` The ${cheaper} is ${formatPrice(difference)} cheaper.`;
    }
  }

  return `Here's how the ${names.join(' and ')} compare on the specifications ShopiQ tracks.${priceLine} ${comparison.summary} The full table is below.`;
}

/**
 * The first requested brand ShopiQ does not stock at all, if any.
 *
 * Distinguishes "we have none of that brand" — a fact worth stating plainly —
 * from "that brand exists here but nothing met the other requirements", where
 * relaxing a filter is the useful suggestion.
 */
async function firstUnstockedBrand(brands: string[]): Promise<string | null> {
  for (const brand of brands.slice(0, 3)) {
    try {
      const { products } = await searchProductSummaries({
        query: null,
        category: null,
        brand: [brand],
        min_price: null,
        max_price: null,
        min_rating: null,
        filters: null,
        in_stock_only: false,
        sort: 'relevance',
        limit: 1,
      });
      if (products.length === 0) return brand;
    } catch {
      // A lookup failure is not evidence of absence — say nothing about it.
      return null;
    }
  }
  return null;
}

/**
 * Words that describe the thing itself, not the way it was asked for.
 *
 * "check if Xiaomi Charger is in stock" is about a Xiaomi charger; "check",
 * "stock" and "is" are the question wrapped around it.
 */
const ASKING_WORDS = new Set([
  'check', 'stock', 'available', 'availability', 'have', 'has', 'any', 'some',
  'show', 'find', 'want', 'need', 'looking', 'look', 'get', 'buy', 'give',
  'please', 'there', 'your', 'you', 'the', 'and', 'for', 'with', 'that', 'this',
  'about', 'tell', 'know', 'like', 'would', 'could', 'does', 'has', 'are',
]);

function buildEmptyMessage(requirements: ShoppingRequirements, asked?: string): string {
  // What the shopper actually named beats an inferred category. Asked after a
  // Xiaomi charger, this used to answer "nothing for gaming accessories" — a
  // category they never mentioned, guessed from one word, which reads as the
  // assistant having misheard them entirely.
  const subject = (asked ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // Digits are the budget, which is appended separately below — keeping them
    // here produced "for laptop under 80000 under ₹80,000".
    .filter((word) => word.length > 2 && !ASKING_WORDS.has(word) && !/\d/.test(word))
    .slice(0, 4)
    .join(' ');

  const bits: string[] = [];
  if (subject) bits.push(subject);
  else if (requirements.category) bits.push(requirements.category.toLowerCase());
  if (requirements.budget.max !== null) bits.push(`under ${formatPrice(requirements.budget.max)}`);

  const description = bits.length > 0 ? ` for ${bits.join(' ')}` : '';
  return `I couldn't find anything in the ShopiQ catalogue${description}. Tell me what you'll use it for and I'll suggest the closest thing I do stock.`;
}
