# Supabase Auth email templates

Paste these into **Supabase Dashboard → Authentication → Emails**.

ShopiQ is passwordless: `signInWithOtp` is the only way in, and the customer
types a six-digit code. Supabase's stock templates send a **magic link**
(`{{ .ConfirmationURL }}`) instead, which is why sign-in appeared to send a
"Supabase link". Every template below uses `{{ .Token }}`.

## Which templates ShopiQ actually uses

| Supabase template | File | When it fires |
| --- | --- | --- |
| **Confirm signup** | `confirm-signup.html` | First sign-in — the address has no account yet |
| **Magic Link** | `magic-link.html` | Returning customer signing in |
| Reauthentication | `reauthentication.html` | Only if you later enable sensitive-change confirmation |

`signInWithOtp({ shouldCreateUser: true })` picks between the first two on its
own, so **both must be updated** — updating only one leaves half your customers
receiving a link.

## Templates ShopiQ does NOT use

| Template | Why |
| --- | --- |
| **Reset Password** | No passwords exist. Nothing can reset. |
| **Invite user** | ShopiQ never invites; customers arrive by shopping. |
| **Change Email Address** | Email is the sign-in credential and is deliberately not editable. |

Leave those at their defaults — they will never be sent.

## Subject lines

Set these alongside each template. Putting the code in the subject means it is
visible from the notification, which saves opening the mail at all:

- **Confirm signup** — `Your ShopiQ code: {{ .Token }}`
- **Magic Link** — `Your ShopiQ sign-in code: {{ .Token }}`
- **Reauthentication** — `Confirm it is you: {{ .Token }}`

## Also worth setting

**Authentication → SMTP Settings.** Without your own SMTP, Supabase sends
through its shared mailer, which is rate-limited to a few messages per hour and
will throttle mid-demo. Use the same credentials already in `.env.local`:

    Host      smtp.gmail.com
    Port      587
    Username  (your SMTP_USER)
    Password  (your SMTP_PASSWORD — the Gmail App Password)
    Sender    shopiq@yashgarg.co.in
    Name      ShopiQ

**Minimum interval per user** defaults to 30s in that screen. That is sensible
for production but slow while testing; lower it temporarily if you are trying
the flow repeatedly.

## A note on the logo

The templates reference the logo at its public CDN URL. Most clients block
remote images by default, so the wordmark is rendered as **text** beside it —
the branding survives even when the image does not load.
