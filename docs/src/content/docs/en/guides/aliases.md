---
title: Aliases
description: How addresses come into being — catch-all, created by hand, subaddressing, and switching one off.
---

An alias is one address on your domain. You never have to create one before
using it.

## Catch-all: just invent the address

Any address on your mail domain is accepted, and the alias appears in the
dashboard when the first message lands. Type `netflix@yourdomain.com` into a
signup form and it exists the moment mail arrives.

Auto-created aliases are marked **auto** in the sidebar, so an address you do
not recognise is explicable rather than mysterious.

### The guards

Email Routing hands the Worker every address a spammer cares to guess, so the
accept path is bounded:

| Guard | Behaviour |
|---|---|
| Domain | only your mail domain; anything else is rejected outright |
| Local part | must be a valid alias (`[a-z0-9._-]`, up to 64 characters) |
| Volume | 50 new addresses per rolling day |
| Disabled alias | stays rejected — the catch-all will not resurrect it |

The daily budget counts **auto-created aliases only**, so ones you made by hand
never consume it. Past the limit, senders get a *temporary* failure and retry,
rather than a bounce that loses a real message caught in someone else's burst.

## Creating one by hand

**New Alias** in the sidebar, when you want the address to exist before the
first message — printing it somewhere, or picking the exact spelling.

- **Random** — a prefix plus four hex characters, e.g. `news-4f2a`.
- **Custom** — you choose the local part.

The address is copied to your clipboard on creation.

## Subaddressing

`news+netflix@yourdomain.com` delivers to the alias `news`. The `+tag` is a
label for your own filtering; it does not create a second alias.

## Switching one off

Disable an alias when it starts receiving spam. Mail to it is then rejected at
the SMTP level, before anything is stored — the sender gets a bounce and you
pay no storage.

Disabling is durable: the catch-all will not silently recreate an address you
turned off.

Existing messages stay in your mailbox; disabling stops new arrivals, it does
not delete history.

## Where aliases live

Aliases belong to your **mail domain** — the zone apex, e.g. `yourdomain.com`
— not the dashboard hostname (`inbox.yourdomain.com`). Email Routing's
catch-all is bound to the apex, so that is the domain that can receive.
