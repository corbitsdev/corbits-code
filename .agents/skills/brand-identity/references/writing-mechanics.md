# Grammar and Mechanics

House style rules for all Corbits content. Adhering to these keeps writing
clear and consistent across docs, marketing, product UI, and social.

---

## Basics

**Write for all readers but especially agents.** Some people will read every
word. Others will skim. Help everyone by grouping related ideas and using
descriptive headers compatible with markdown formatting.

**Focus your message.** Lead with the main point. Create a hierarchy of
information -- in sentences, paragraphs, sections, and pages.

**Be concise.** Use short words and sentences. Avoid unnecessary modifiers.

**Be specific.** Avoid vague language. Cut the fluff.

**Be consistent.** Stick to the patterns outlined in this guide.

---

## Abbreviations and Acronyms

If there's a chance your reader won't recognize an abbreviation, spell it
out the first time. Then use the short version.

- First use: Network Operations Center
- Second use: NOC

If the abbreviation is well known to Agent Operators (CLI, MCP, API, JSON,
HTTP, REST, UTC), use it directly without spelling out.

---

## Active Voice

Use active voice. Avoid passive voice.

In active voice, the subject does the action. In passive voice, the subject
receives the action.

- DO: The agent routes the request.
- NOT: The request was routed by the agent.

Words like "was" and "by" often indicate passive voice. Scan for these and
rework.

One exception: when you want to emphasize the action over the subject.

- OK: Your provenance log was verified by the network.

---

## Capitalization

We use sentence case for most content. Title case is reserved for proper
nouns and branded terms.

Always capitalize:

- Corbits (the company)
- Neoteams (the category we are building)
- Interchange (the orchestration platform)
- Faremeter (the payments and provenance libraries)
- Agent Ops (the role/function)
- x402 (the protocol, always lowercase)

Never capitalize in a sentence:

- agent (unless starting a sentence)
- neoteams (unless referring to the category explicitly)
- provenance (it's a concept, not a brand)
- orchestration
- federation
- blockchain
- infrastructure

When writing code, APIs, or URLs, follow their native formats:

- https://api.corbits.dev
- GET /v1/agents
- x-faremeter-

---

## Contractions

Use them. They make writing conversational and direct.

- DO: "We're building the infrastructure for Neoteams."
- DO: "The agent can't complete the task without proper authentication."

---

## Numbers

Numbers over 3 digits get commas:

- 999
- 1,000
- 150,000

Write out big numbers in full. Abbreviate only if space is constrained
(tweets, charts): 1k, 150k.

Agent counts and metrics:

- "Your Neoteam has 5 agents and 3 humans"
- "Processed 10,000 transactions"

---

## Dates

Spell out the day of the week and month. Abbreviate only if space is tight.

- DO: Friday, January 24
- OK if short: Fri., Jan. 24

---

## Money

Use the symbol before the amount. Include cents if more than 0.

- $20
- $19.99

For x402 microtransactions, be precise:

- $0.005 per call
- 100,000 calls = $500.00

For cryptocurrencies and foreign currencies, add them after the amount:

- 20 USDC
- 19.99 EUR

---

## Time

Use numerals with am or pm, lowercase, with a space.

- 7 am
- 7:30 pm
- 2 pm -- 5 pm

Specify time zones when relevant. Since Corbits is global, use UTC for
technical documentation and the reader's local zone for events.

- Technical: 14:00 UTC
- Event: 2 pm ET

---

## Punctuation

### Apostrophes

Use for possession and contractions. Not for plurals.

- DO: The agent's provenance log
- DO: The agents' coordination protocol
- DO: It's (it is) working
- NOT: The agent's are running (incorrect)

### Colons

Use to offset a list or join related phrases. Capitalize the first word
after a colon if it's a complete sentence.

- DO: The agent requires three things: an API key, a valid prompt, and a
  provenance destination.
- DO: We faced a dilemma: the agent had processed the payment, but the audit
  trail was incomplete.

### Commas

Use the serial (Oxford) comma in lists.

- DO: The Neoteam includes agents, humans, and Interchange.
- NOT: The Neoteam includes agents, humans and Interchange.

Use common sense otherwise. If you're unsure, read the sentence out loud.
Where you pause, use a comma.

### Dashes and Hyphens

Use a hyphen (-) without spaces to link words or indicate a range.

- cross-company
- 2-3 days
- API-first

Use an em dash (--) with spaces to offset an aside.

- DO: The provenance log -- stored on the blockchain -- verifies every
  action.
- DO: The agent failed mid-transaction -- an edge case we hadn't tested.

Use a true em dash, not hyphens.

### Ellipses

Use sparingly to indicate trailing off. Don't use for emphasis.

- DO: "The agent processed the request... then halted."
- NOT: "Amazing..."

Use [...] in brackets to show omitted words in a quote.

### Periods

Go inside quotation marks. Outside parentheses when the parenthetical is
part of a larger sentence; inside when it stands alone.

- DO: The Agent Operator said, "The task is complete."
- DO: The agent finished (and the provenance was recorded).
- DO: The agent finished. (The provenance was recorded later.)

Leave one space between sentences.

### Question Marks

Go inside quotation marks if part of the quote. Outside parentheses when the
parenthetical is part of a larger sentence; inside when it stands alone.

### Exclamation Points

Use sparingly. Never more than one.

- DO: "The Neoteam is live!"
- NOT: "Amazing!!!"

Never use in failure messages or alerts. When in doubt, avoid.

### Quotation Marks

Use for words and letters, short work titles, and direct quotations. Periods
and commas go within quotation marks.

- DO: The term "provenance" refers to the chain of custody.
- DO: The agent returned "null" instead of the expected value.
- DO: Who said, "Trust but verify"?

Use single quotation marks for quotes within quotes.

### Semicolons

Go easy on them. They usually support long, complicated sentences that
should be simplified. Try an em dash or start a new sentence.

### Ampersands

Don't use unless part of a company name.

- DO: Ben and Jerry
- DO: Ben & Jerry's

---

## Writing About Other Companies

Honor companies' own names. Go by what's on their official website.

- DO: Stripe
- DO: OpenAI
- DO: LangChain

Refer to a company or product as "it" (not "they").

- DO: Stripe handles the initial payment; Corbits handles the agent
  settlement.

---

## Slang and Jargon

Write in plain English. If you must use a technical term, define it briefly.

- DO: Corbits uses provenance -- cryptographic proof of what agents did --
  to verify cross-company transactions.
- DO: Interchange acts as the orchestration layer, coordinating handoffs
  between agents without centralized control.

Avoid AI hype terms unless necessary: "agentic," "autonomous,"
"intelligent," "AI-native." If you use them, define what you actually mean.

---

## Text Formatting

### Code

Use code formatting (monospace) for:

- API endpoints: `GET /v1/agents`
- JSON payloads: `{"agent_id": "123"}`
- Function names: `process_payment()`
- Command line: `corbits deploy`

### Italics

Use for:

- Emphasis: "This is *critical* for audit trails."
- First use of technical terms: "*Provenance* means cryptographic proof of
  action."

### Bold

Use sparingly for strong emphasis or UI elements.

- DO: Click **Deploy** to start the agent.

Don't use: underline, or combinations of bold/italic/underline/caps.

Left-align text. Never center or right-align body text.

---

## Writing Positively

Use positive language rather than negative. Look for "can't," "don't,"
"won't" and flip them.

- DO: The agent requires authentication to proceed.
- NOT: The agent can't proceed without authentication.
- DO: Set up provenance tracking to verify actions.
- NOT: Don't deploy agents without provenance tracking.

---

## Copyright and Trademarks

### Copyright

Standard notice: (c) [YEAR] ABK Labs.

Longer notice where appropriate: (c) [YEAR] All Rights Reserved.

Copyright applies to everything we create: code, documentation, blog posts,
designs, and marketing materials.

### Using Others' Work

We respect others' copyrights. Always obtain a license before using external
work. A license typically covers where, how long, and what you can do with
the work.

Social media posts with copyrighted images, GIFs, or code snippets: assume
our use will be perceived as commercial and request permission when needed.
Always link to the source.

### Trademarks

Use the (TM) symbol the first time a mark appears in a document.

Don't combine our marks with other words without approval:

- NOT: "Corbits-powered" or "Corbits-compatible"

Respect others' trademarks and use their preferred formatting. Don't use (R)
on any mark unless legally registered.
