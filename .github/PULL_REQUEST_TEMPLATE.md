<!--
Thanks for contributing to ShopiQ.

Keep this focused on one change — it makes review possible and a revert cheap.
-->

## What this changes

<!-- One or two sentences. What is different after this is merged? -->

## Why

<!--
The reasoning, not just the symptom. If this is a bug fix, what was the actual
cause? "The waiter was armed after the event it was waiting for" tells a
reviewer far more than "fixed a timeout".
-->

Closes #

## How it was tested

<!--
Please be specific, and say what you did NOT run. "I did not run the payment
suites" is useful; a ticked box that implies otherwise is not.
-->

```
# commands you ran, and what they printed
```

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] Relevant test suites pass — which ones: <!-- list them -->
- [ ] Tested manually in the browser — how: <!-- describe -->

## Screenshots

<!-- For anything visual. Include mobile if it touches layout — most of this
     project's layout bugs only appeared under 400px. -->

## Money, identity and secrets

<!--
Tick only what applies. If any of the first three are ticked, please explain
below how the guarantee still holds. See CONTRIBUTING.md.
-->

- [ ] This touches pricing, totals, payments or checkout
- [ ] This touches customer identity, sessions or account data
- [ ] This changes what the AI is allowed to do, or which tools it can call
- [ ] This adds or changes an environment variable
- [ ] **None of the above**

If you ticked any of the first three:

<!-- How does this preserve the invariants? Specifically: the model still
     cannot set an amount, identity still comes from the session, and a
     payment still requires explicit authorisation of an exact figure. -->

## Checklist

- [ ] No secrets, keys or credentials are in the diff (check `.env.local` is not staged)
- [ ] No new `@typescript-eslint/no-explicit-any` errors introduced
- [ ] Comments explain *why*, where the reasoning is not obvious from the code
- [ ] Database changes are a new numbered migration in `supabase/migrations/`,
      and do not delete or rewrite existing customer data
- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md)
