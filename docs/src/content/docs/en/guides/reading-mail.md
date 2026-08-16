---
title: Reading mail
description: Messages render as they were sent — and what MailRiz withholds until you ask.
---

Messages are shown as their sender wrote them: their CSS, their tables, their
layout. Nothing is stripped for presentation.

## Remote images are withheld

A tracking pixel tells the sender that you opened the message, when, and from
roughly where. So images hosted elsewhere are not loaded. When a message
references any, a line appears above it:

> ▲ 2 external images are blocked for your privacy. **[Show images]**

Pressing it reloads that message with them allowed. The choice applies to the
message you are reading, not permanently to the sender.

Nothing reaches a third-party server before you press it.

## Embedded images just work

Pictures attached to the message itself — logos, signatures — are part of the
message rather than a call to someone else's server, so they render straight
away with no prompt. They cost no privacy.

They also stay in the attachment list, so you can download the original file.

**SVG is the exception**: it can carry script, so it is always a download and
never rendered inline.

## Attachments

Listed under the message header with filename and size. Selecting one
downloads it — attachments are never opened in place.

The original `.eml` is downloadable too, from the document icon in the message
toolbar. That is the message exactly as it arrived, headers included, which is
what you want for forwarding a report or checking a signature.

## How this is kept safe

The body is served in a sandboxed frame under a strict Content-Security-Policy
that denies scripts entirely — so rendering a message as-sent does not mean
running whatever it contains. [Security](/mailriz/en/internals/security/) has
the detail.

## Plain-text messages

Messages with no HTML part render as text. Where a message has both, the HTML
is shown — they are two renderings of the same thing, and displaying both would
print it twice.
