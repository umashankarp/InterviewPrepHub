(function (r) {
registerTopic('31-domain-driven-design', {
related: ['30-architecture-patterns', '34-cqrs', '17-microservices'],
questions: [
{ id: 'q1', level: 'Basic', tags: ['ddd', 'strategic', 'tactical'],
  q: r`What is Domain-Driven Design, what is the difference between strategic and tactical DDD, and how do you decide whether a system deserves it?`,
  a: r`**Domain-Driven Design** (Eric Evans, 2003) tackles complex business software by building a **model** of the domain together with domain experts, expressing it in a **ubiquitous language**, and organising the software around **bounded contexts**.

| | Strategic DDD | Tactical DDD |
|---|---|---|
| Question | *where are the boundaries?* | *how do we model inside one boundary?* |
| Tools | subdomains, bounded contexts, context maps, team alignment | entities, value objects, aggregates, domain events, repositories, domain services |
| Cost of getting it wrong | very high: coupled teams, distributed monolith | moderate: local refactoring |

Teams often over-invest in tactical patterns and get boundaries wrong, which is the expensive mistake.

### When it pays off
- The domain is **complex and core** to the business: payments, trading, underwriting, pricing, logistics rules.
- Rules change often and are discussed with experts.
- Several teams work on the same problem space and need clear ownership.

### When it does not
- CRUD over a database with little behaviour: a transaction script or plain EF Core is cheaper.
- **Generic** capabilities (identity, email, invoicing): buy them.
- No access to domain experts: you would be modelling guesses.

### My rule
Use **strategic** DDD almost everywhere (it is just disciplined boundary design). Apply rich **tactical** modelling only to core, complex subdomains.`,
  code: r`~~~csharp
// CRUD area: no tactical DDD needed
app.MapPut("/countries/{code}", async (string code, CountryDto dto, RefDataDb db, CancellationToken ct) =>
{
    var c = await db.Countries.FindAsync([code], ct) ?? new Country { Code = code };
    c.Name = dto.Name; c.IsSanctioned = dto.IsSanctioned;
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// Core area: rich model where rules live with the data they protect
public sealed class Payment : AggregateRoot<PaymentId>
{
    public void Capture(Money amount, DateTimeOffset at)
    {
        if (Status != PaymentStatus.Authorised) throw new DomainException("Only authorised payments can be captured");
        if (amount.Currency != Authorised.Currency || amount > Authorised - Captured)
            throw new DomainException("Capture exceeds authorised amount");
        Captured += amount;
        Status = Captured == Authorised ? PaymentStatus.Captured : PaymentStatus.PartiallyCaptured;
        Raise(new PaymentCaptured(Id, amount, at));
    }
}
~~~`,
  pts: [r`DDD models complex domains with experts, in bounded contexts, using a ubiquitous language.`, r`Strategic DDD sets boundaries; tactical DDD models inside them.`, r`Wrong boundaries are the costly mistake.`, r`Rich models for complex core domains; CRUD and generic areas stay simple or are bought.`, r`No domain experts means no real DDD.`],
  ex: r`A lender applied aggregates, repositories and domain events to 40 reference-data screens and shipped slowly for a year, while its underwriting rules lived in stored procedures nobody understood. Reversing the investment (plain CRUD for reference data, a rich model for underwriting) cut defects in underwriting changes by half.`,
  fu: [r`Can you do strategic DDD without tactical DDD?`, r`How would you explain DDD's value to a CFO?`, r`What signals tell you a domain is complex enough?`],
  pit: [r`Tactical patterns everywhere.`, r`DDD without access to domain experts.`, r`Treating DDD as a folder structure.`] },

{ id: 'q2', level: 'Basic', tags: ['ddd', 'ubiquitous-language'],
  q: r`What is the ubiquitous language, how does it show up in code, and why is a word that means different things in different places a design signal?`,
  a: r`The **ubiquitous language** is the precise shared vocabulary of domain experts and developers, used in conversations, **class and method names**, tests, events and documentation, **within one bounded context**.

### Why it matters
- Removes translation: when the expert says "a hold is released on settlement", the code says {{hold.Release()}} in {{SettlementPolicy}}.
- Makes the model discussable: experts can read tests and event names and spot wrong rules.
- Reveals **boundaries**: if "account" means a login in Identity, a ledger account in Accounting and a customer relationship in Sales, those are **different contexts** with different models. Forcing one meaning creates a muddled model.

### In code
- Intention-revealing operations instead of setters and status codes: {{payment.Refund(amount, reason)}}, not {{payment.Status = 7}}.
- Domain types instead of primitives: {{Iban}}, {{Money}}, {{SettlementDate}}.
- Events named in the past tense, in business terms: {{PaymentCaptured}}, not {{PaymentUpdated}}.
- A **glossary** per context, versioned with the code.

### Keeping it alive
Language changes as understanding grows: rename in code when experts refine terms ("chargeback" vs "dispute"), and treat persistent mismatches between code names and expert words as defects.`,
  code: r`~~~csharp
// Not the language: generic CRUD verbs and magic numbers
order.Status = 3;
order.Flag2 = true;
repo.Update(order);

// The language: what the business actually says
order.PlaceOnHold(HoldReason.SanctionsReview);
order.ReleaseHold(by: complianceOfficer);
order.Ship(trackingNumber);

// Same word, different contexts, different models
namespace Identity   { public sealed record Account(UserId Id, Email Login, bool MfaEnabled); }
namespace Accounting { public sealed class Account { public LedgerCode Code { get; } public Money Balance { get; private set; } } }
namespace Sales      { public sealed class Account { public CustomerId Customer { get; } public AccountManager Owner { get; private set; } } }

// Tests readable by experts
[Fact]
public void A_captured_payment_cannot_be_captured_again()
{
    var payment = Payments.Authorised(Money.Gbp(100));
    payment.Capture(Money.Gbp(100), Now);
    Assert.Throws<DomainException>(() => payment.Capture(Money.Gbp(1), Now));
}
~~~`,
  pts: [r`Shared vocabulary used literally in code, tests and events.`, r`Valid within one bounded context only.`, r`Same word with different meanings signals a context boundary.`, r`Intention-revealing methods, domain types, past-tense business events.`, r`Language evolves: rename the code when the understanding changes.`],
  ex: r`In a card-issuing system "limit" meant credit limit to Risk, spending control to the mobile team and regulatory cap to Compliance; one Limit table served all three and every change broke someone. Splitting into three contexts with their own terms ended a year of conflicting releases.`,
  fu: [r`How do you handle a term that experts themselves disagree on?`, r`Should the database schema use the ubiquitous language too?`, r`How do you keep a glossary from going stale?`],
  pit: [r`Generic names like Manager, Processor, Data.`, r`One meaning forced on a word across the company.`, r`Developers inventing terms experts do not use.`] },

{ id: 'q3', level: 'Basic', tags: ['ddd', 'entities', 'value-objects', 'primitive-obsession'],
  q: r`Entity vs value object: how do you decide, how do you implement value objects in C#, and how do they fix primitive obsession?`,
  a: r`| | Entity | Value object |
|---|---|---|
| Defined by | **identity** that persists through change | its **attributes** |
| Equality | by id | by value |
| Mutability | changes through behaviour | **immutable**: replace, do not modify |
| Examples | Order 42, Account, Customer | Money, Iban, Address, DateRange, Quantity, Percentage |

**Test**: "if two have the same attributes, are they interchangeable?" Yes → value object. "Do we track it over time even if all attributes change?" → entity. When in doubt, start with a value object.

### Value objects in C#
- {{record}} or {{readonly record struct}} for structural equality.
- **Self-validating** constructors: an invalid {{Iban}} or negative {{Quantity}} cannot exist ("always valid").
- **Side-effect-free behaviour**: {{money.Add(other)}} returns a new value and enforces currency rules.

### Primitive obsession
Using {{decimal}}, {{string}} and {{Guid}} for domain concepts scatters validation and lets incompatible values mix: an amount without a currency, a customer id passed where an account id was expected, an unvalidated IBAN. Value objects and **strongly typed ids** centralise rules and make wrong code fail to compile.

### Persistence
EF Core complex types (EF 8+) or owned types for value objects; value converters for single-value types and strongly typed ids.`,
  code: r`~~~csharp
public readonly record struct Money
{
    public decimal Amount { get; }
    public string Currency { get; }
    public Money(decimal amount, string currency)
    {
        if (currency is not { Length: 3 }) throw new ArgumentException("ISO 4217 currency required", nameof(currency));
        Amount = amount; Currency = currency;
    }
    public static Money Gbp(decimal a) => new(a, "GBP");
    public Money Add(Money o) => o.Currency == Currency ? new(Amount + o.Amount, Currency) : throw new CurrencyMismatchException(Currency, o.Currency);
    public static bool operator >(Money a, Money b) => a.Currency == b.Currency ? a.Amount > b.Amount : throw new CurrencyMismatchException(a.Currency, b.Currency);
    public static bool operator <(Money a, Money b) => b > a;
}

public sealed record Iban
{
    public string Value { get; }
    public Iban(string raw)
    {
        var v = raw.Replace(" ", "").ToUpperInvariant();
        if (!Mod97.IsValid(v)) throw new InvalidIbanException(raw);
        Value = v;
    }
}

public readonly record struct AccountId(Guid Value);
public readonly record struct CustomerId(Guid Value);

// Primitive obsession: compiles, wrong argument order, no currency
void TransferBad(Guid from, Guid to, decimal amount) { }
// Typed: wrong order or missing currency does not compile
void Transfer(AccountId from, AccountId to, Money amount) { }
~~~`,
  pts: [r`Entities have identity over time; value objects are defined by their values.`, r`Value objects are immutable, self-validating, compared by value.`, r`records and readonly record structs implement them cheaply in C#.`, r`Strongly typed ids and value objects remove primitive obsession.`, r`Map with complex types, owned types or converters.`],
  ex: r`A payments API passed amounts as decimal and currency as a separate string; a refactor swapped two parameters and refunded 1,000 JPY as 1,000 GBP for 300 customers. Introducing Money and typed ids made the same mistake a compile error.`,
  fu: [r`Can a value object contain an entity?`, r`Is Address an entity or value object in a delivery-tracking system?`, r`What are the costs of strongly typed ids with EF Core and JSON?`],
  pit: [r`Mutable value objects.`, r`Validation scattered in controllers.`, r`Entities compared by all fields.`] },

{ id: 'q4', level: 'Basic', tags: ['ddd', 'subdomains', 'investment'],
  q: r`Core, supporting and generic subdomains: how do you classify them, and how does the classification change staffing, design depth and build-vs-buy decisions?`,
  a: r`| Type | What it is | Strategy |
|---|---|---|
| **Core** | the competitive advantage: pricing, risk scoring, matching, fraud decisioning | best people, rich model, build in-house, heavy testing, fast iteration |
| **Supporting** | business-specific but not differentiating: onboarding workflows, internal reporting, back-office tools | simpler designs, pragmatic code, outsourcing possible |
| **Generic** | the same for every business: identity, email, payments gateway, general ledger product, HR | **buy** or use SaaS/open source, integrate behind an anti-corruption layer |

### How to classify
- Ask the business: "if we did this twice as well as competitors, would we win more customers or margin?" Yes → core.
- Look at strategy documents and where the business invests.
- Classifications **change**: what was core (a card-processing engine in 2005) can become generic (buy an issuer processor today).

### What it changes
- **People**: senior engineers and domain experts on core.
- **Design depth**: tactical DDD, event sourcing or advanced patterns only where they pay off.
- **Quality bar**: property-based tests and simulation for core rules; standard tests elsewhere.
- **Buy vs build**: building a generic subdomain is spending scarce engineering on something customers do not value.
- **Dependencies**: core should not be held hostage by a vendor model; wrap generic products in ACLs.`,
  code: r`~~~text
Digital lender: subdomain map

Core        Credit decisioning (risk models, policy rules)   build, rich model, best team
Core        Pricing (risk-based APR, offers)                  build, rich model
Supporting  Application workflow / document collection        build simply (workflow engine)
Supporting  Collections strategies                            build pragmatically
Generic     Identity & MFA                                    buy (Entra ID / Auth0)
Generic     KYC / AML screening                               buy (vendor) behind an ACL
Generic     Payments (disbursement, direct debit)             buy (PSP) behind an ACL
Generic     General ledger                                    buy (ERP), publish journal events to it
~~~
~~~csharp
// Generic subdomain behind an ACL: our model, vendor details hidden
public interface IIdentityVerification
{
    Task<VerificationOutcome> VerifyAsync(Applicant applicant, CancellationToken ct);
}
internal sealed class OnfidoVerification(OnfidoClient client) : IIdentityVerification
{
    public async Task<VerificationOutcome> VerifyAsync(Applicant a, CancellationToken ct)
    {
        var check = await client.CreateCheckAsync(a.ToOnfidoApplicant(), ct);
        return check.Result switch { "clear" => VerificationOutcome.Passed, "consider" => VerificationOutcome.ManualReview, _ => VerificationOutcome.Failed };
    }
}
~~~`,
  pts: [r`Core = differentiator, supporting = specific but not differentiating, generic = same everywhere.`, r`Invest people and design depth in core.`, r`Buy generic subdomains and wrap them in ACLs.`, r`Classifications change over time.`, r`The classification drives testing rigour and architecture choices.`],
  ex: r`A fintech spent 18 months building its own identity and MFA platform (generic) while its credit-decisioning engine (core) ran on spreadsheets exported nightly. Moving to a bought identity provider freed five engineers who rebuilt decisioning, cutting approval time from days to minutes.`,
  fu: [r`Can a generic subdomain become core?`, r`How do you handle a vendor whose model leaks into your core domain?`, r`Who should own the classification?`],
  pit: [r`Building generic capabilities in-house by default.`, r`Juniors on the core domain.`, r`Treating the classification as permanent.`] },

{ id: 'q5', level: 'Basic', tags: ['ddd', 'bounded-context', 'microservices', 'modular-monolith'],
  q: r`What is a bounded context, how is it different from a subdomain, a microservice and a module, and why is one shared enterprise model a mistake?`,
  a: r`A **bounded context** is an explicit boundary **within which one model and its language are consistent**. The same real-world concept has different models in different contexts: a Customer in Sales (leads, account manager), Billing (payment terms, invoices) and Support (tickets, SLA).

| Concept | Space | Meaning |
|---|---|---|
| **Subdomain** | problem space | a part of the business (lending, collections) |
| **Bounded context** | solution space | a model boundary we design |
| **Microservice** | deployment | an independently deployable process |
| **Module** | code organisation | a component inside one deployable |

Ideally subdomain ≈ context ≈ team. A context usually maps to **one service** or **one module of a modular monolith**; it can occasionally be split into several deployables for scaling, but **one service must never span several contexts' models**.

### Ownership
A context owns its **data** (its own schema or database, one DbContext), its **language** and its **API/events**. Other contexts integrate through published contracts or IDs, never through its tables.

### The shared enterprise model mistake
A canonical {{Customer}} with every field from every department: every team must agree on every change, the model gets contradictory rules, releases couple, and nobody owns it. Separate models per context, linked by ids and events, let teams move independently. Duplication of a few fields across contexts is cheaper than coupling.`,
  dia: r`flowchart LR
  subgraph Sales context
    SC[Customer: lead, owner, segment]
  end
  subgraph Billing context
    BC[Customer: terms, invoices, dunning]
  end
  subgraph Support context
    SUP[Customer: tickets, SLA]
  end
  SC -- CustomerSigned event with CustomerId --> BC
  SC -- CustomerSigned event --> SUP`,
  code: r`~~~text
src/
  Billing/
    Billing.Api/              endpoints, DTOs, auth
    Billing.Application/      use cases, ports
    Billing.Domain/           aggregates, value objects, events (no infrastructure references)
    Billing.Infrastructure/   BillingDbContext (schema "billing"), outbox, adapters
  Sales/ ...                  its own model, DbContext, schema "sales"
~~~
~~~csharp
// Billing's own view of a customer: only what billing needs
namespace Billing.Domain;
public sealed class BillingAccount : AggregateRoot<BillingAccountId>
{
    public CustomerId Customer { get; private set; }        // reference by id, not Sales' Customer type
    public PaymentTerms Terms { get; private set; }
    public void ChangeTerms(PaymentTerms terms) { /* billing rules */ }
}

// One DbContext per context, own schema
public sealed class BillingDbContext(DbContextOptions<BillingDbContext> o) : DbContext(o)
{
    protected override void OnModelCreating(ModelBuilder mb) => mb.HasDefaultSchema("billing");
}
~~~`,
  pts: [r`Bounded context = boundary of one consistent model and language.`, r`Subdomain is problem space; context is solution space; service is deployment.`, r`A context owns its data, language and contracts.`, r`One service must not span several contexts' models.`, r`Shared canonical models couple every team; duplicate a few fields instead.`],
  ex: r`An insurer's "Party" master table had 240 columns used by 14 teams; adding a field took a six-week change board. Splitting into context-specific models (policyholder, claimant, broker) with a shared party id let teams ship weekly again.`,
  fu: [r`When would you split one context into two services?`, r`How do contexts share reference data?`, r`What does a context boundary look like inside a modular monolith?`],
  pit: [r`One DbContext spanning contexts.`, r`Services split by entity rather than context.`, r`Cross-context table access.`] },

{ id: 'q6', level: 'Basic', tags: ['ddd', 'aggregates', 'invariants'],
  q: r`What is an aggregate and an aggregate root, what are the core design rules, and why must all changes go through the root?`,
  a: r`An **aggregate** is a cluster of entities and value objects treated as **one consistency unit**. Its **root** is the only object outsiders may reference or call; **invariants inside the aggregate hold after every transaction**.

### Rules (Vaughn Vernon)
1. **Protect true invariants** inside the boundary: include exactly what must be consistent immediately.
2. **Design small aggregates**: large ones cause contention, slow loads and memory waste.
3. **Reference other aggregates by id only**, never by object reference.
4. **Modify one aggregate per transaction**; use eventual consistency (domain events) between aggregates.

### Why only through the root
If outside code can add an {{OrderLine}} directly, nothing checks "max 100 lines", "only draft orders change" or "total within credit cap". The root **encapsulates** the collection (read-only exposure), validates every change, and raises events. This is what makes invariants enforceable.

### Concurrency
A version (rowversion) on the root makes concurrent changes to the same aggregate conflict instead of silently interleaving; the losing transaction retries against fresh state.

### Loading
Load the **whole aggregate** through its repository (tracked), change it via methods, save. Partial loading or modifying children directly through another query breaks the guarantees.`,
  code: r`~~~csharp
public sealed class Order : AggregateRoot<OrderId>
{
    private readonly List<OrderLine> _lines = [];
    public CustomerId CustomerId { get; private set; }               // other aggregate by id
    public OrderStatus Status { get; private set; } = OrderStatus.Draft;
    public string Currency { get; private set; }
    public IReadOnlyCollection<OrderLine> Lines => _lines.AsReadOnly();
    public Money Total => _lines.Aggregate(new Money(0, Currency), (t, l) => t.Add(l.Subtotal));
    public byte[] RowVersion { get; private set; } = [];              // optimistic concurrency on the root

    private Order() { CustomerId = default; Currency = default!; }   // EF Core
    public Order(OrderId id, CustomerId customer, string currency) : base(id) { CustomerId = customer; Currency = currency; }

    public void AddLine(Sku sku, int qty, Money unitPrice)
    {
        if (Status != OrderStatus.Draft) throw new DomainException("Only draft orders can change");
        if (qty <= 0) throw new DomainException("Quantity must be positive");
        if (_lines.Count >= 100) throw new DomainException("An order has at most 100 lines");
        var existing = _lines.SingleOrDefault(l => l.Sku == sku);
        if (existing is not null) existing.Increase(qty); else _lines.Add(new OrderLine(sku, qty, unitPrice));
    }

    public void Submit()
    {
        if (_lines.Count == 0) throw new DomainException("Cannot submit an empty order");
        Status = OrderStatus.Submitted;
        Raise(new OrderSubmitted(Id, CustomerId, Total));
    }
}

// OrderLine has no public way to be modified from outside the aggregate
public sealed class OrderLine
{
    internal OrderLine(Sku sku, int qty, Money price) { Sku = sku; Quantity = qty; UnitPrice = price; }
    public Sku Sku { get; }
    public int Quantity { get; private set; }
    public Money UnitPrice { get; }
    public Money Subtotal => new(UnitPrice.Amount * Quantity, UnitPrice.Currency);
    internal void Increase(int by) => Quantity += by;
}
~~~`,
  pts: [r`Aggregate = consistency unit; root = only entry point.`, r`Small aggregates, references by id, one aggregate per transaction.`, r`Root encapsulates children so invariants are always checked.`, r`Version on the root turns concurrent changes into conflicts.`, r`Load whole aggregates, change via methods, save.`],
  ex: r`A booking system exposed public setters on reservation lines; a batch job adjusted lines directly and overbooked 400 hotel rooms because the "capacity per night" check lived only in the Reservation methods. Making lines internal and routing the job through the root enforced the rule everywhere.`,
  fu: [r`How do you decide what belongs inside the boundary?`, r`What happens when an aggregate gets too big?`, r`Why reference other aggregates by id instead of navigation?`],
  pit: [r`Public setters and mutable public collections.`, r`Updating several aggregates in one transaction by default.`, r`Navigation properties between aggregates.`] },

{ id: 'q7', level: 'Intermediate', tags: ['ddd', 'event-storming', 'discovery'],
  q: r`How do you run Event Storming to discover a domain you do not know, and how do you turn the wall of stickies into bounded contexts and aggregates?`,
  a: r`### Formats
- **Big picture** (a day, 10 to 25 people across the business): the whole value stream; finds contexts, hot spots and opportunities.
- **Process level**: one process in detail with commands, policies, read models, external systems.
- **Design level**: one context; leads to aggregates and their invariants.

### Notation
Orange **domain events** (past tense: {{LoanApplicationSubmitted}}), blue **commands**, yellow **actors**, lilac **policies** ("whenever X, then Y"), green **read models**, pink **external systems**, red **hot spots** (questions, conflicts, pain), large yellow **aggregates** at design level.

### Facilitation
1. Chaotic exploration: everyone writes events, no discussion.
2. **Enforce the timeline**: order events left to right, merge duplicates, argue about meaning (the arguments are the value).
3. Mark **pivotal events** (application approved, loan disbursed) where the process changes phase.
4. Add hot spots wherever people disagree or say "it depends".
5. Add commands, actors, policies and external systems.

### From stickies to boundaries
- **Pivotal events** and **language changes** between clusters suggest context boundaries.
- Different actors and different rates of change suggest separate contexts.
- At design level, find which events must be guarded by the **same invariant**: those commands and events belong to one aggregate.
- Validate candidate contexts against team ownership and change patterns, then capture the context map.

### Outputs
A context map draft, glossary per context, prioritised hot spots, candidate aggregates, and the integration events between contexts.`,
  dia: r`flowchart LR
  A1[Applicant] --> C1[Submit application]
  C1 --> E1[ApplicationSubmitted]
  E1 --> P1[Policy: run credit checks]
  P1 --> E2[CreditChecked]
  E2 --> C2[Approve]
  C2 --> E3[ApplicationApproved - pivotal]
  E3 --> P2[Policy: create loan account]
  P2 --> E4[LoanDisbursed - pivotal]
  E4 --> E5[RepaymentScheduled]
  H[Hot spot: who owns affordability rules?] -.-> E2`,
  code: r`~~~text
Big-picture output (lending)

Pivotal events:   ApplicationSubmitted | ApplicationApproved | LoanDisbursed | LoanDefaulted
Language shifts:  "applicant" (Origination)  ->  "borrower" (Servicing)  ->  "debtor" (Collections)
Candidate contexts:
  Origination  (core)        events up to ApplicationApproved
  Decisioning  (core)        CreditChecked, AffordabilityAssessed, DecisionMade
  Servicing    (supporting)  LoanDisbursed, RepaymentScheduled, PaymentReceived
  Collections  (supporting)  PaymentMissed, ArrangementAgreed, LoanDefaulted
Hot spots:
  - Affordability rules owned by Risk or Product?          -> decide owner (Decisioning)
  - Manual underwriting overrides not recorded anywhere    -> audit requirement
~~~
~~~csharp
// Design-level result: one aggregate guards the decision invariant
public sealed class CreditApplication : AggregateRoot<ApplicationId>
{
    public void RecordCreditCheck(CreditCheckResult r) { /* ... */ Raise(new CreditChecked(Id, r.Score)); }
    public void Approve(Underwriter by, Money limit)
    {
        if (Score is null) throw new DomainException("Credit check required before approval");
        if (limit > Policy.MaxLimitFor(Score.Value)) throw new DomainException("Limit exceeds policy; override required");
        Status = ApplicationStatus.Approved;
        Raise(new ApplicationApproved(Id, limit, by.Id));
    }
}
~~~`,
  pts: [r`Big-picture, process-level and design-level formats serve different goals.`, r`Events in the past tense on a timeline; arguments surface the real model.`, r`Pivotal events and language changes suggest context boundaries.`, r`Shared invariants identify aggregates at design level.`, r`Outputs: context map, glossaries, hot spots, candidate aggregates and integration events.`],
  ex: r`A two-day big-picture session at a bank revealed that "account opening" spanned four departments with three different meanings of "approved"; the hot spots became the backlog, and the resulting context map defined the first three services of a platform rebuild.`,
  fu: [r`How do you run Event Storming remotely?`, r`What do you do when experts disagree on the order of events?`, r`How do you get senior business stakeholders to attend?`],
  pit: [r`Inviting only engineers.`, r`Jumping to classes and tables during the session.`, r`Ignoring hot spots.`] },

{ id: 'q8', level: 'Intermediate', tags: ['ddd', 'context-mapping', 'team-relationships'],
  q: r`Explain the context-mapping patterns (partnership, shared kernel, customer-supplier, conformist, ACL, open host service, published language, separate ways) and when each is appropriate.`,
  a: r`| Pattern | Relationship | Use when |
|---|---|---|
| **Partnership** | two teams succeed or fail together; joint planning | tightly coupled goals, temporary during a launch |
| **Shared Kernel** | a small shared model or library both own | tiny, stable concepts (Money, CurrencyCode) between close teams |
| **Customer–Supplier** | upstream plans for downstream needs | downstream has influence (priorities, contract reviews) |
| **Conformist** | downstream adopts upstream model as is | upstream will not change and its model is acceptable |
| **Anti-Corruption Layer** | downstream translates upstream's model | legacy, third parties, or models that would distort yours |
| **Open Host Service** | upstream offers a well-defined protocol for many consumers | one provider, many consumers |
| **Published Language** | a documented exchange format | events schemas, ISO 20022, FIX, FHIR |
| **Separate Ways** | no integration | duplication is cheaper than coupling |
| **Big Ball of Mud** | acknowledged messy area | isolate it behind an ACL |

### Reading a context map
Arrows show **upstream** (influences) and **downstream** (is influenced). The map documents **political** reality as much as technical: a conformist relationship exposes a power imbalance; customer-supplier needs a planning process.

### Conway's Law
Context relationships mirror team relationships. Align contexts with teams, and make dependencies explicit so organisational design and architecture evolve together.

### Practical defaults
- Between your own contexts: **OHS + published language** (versioned events and APIs).
- Toward legacy and vendors: **ACL**.
- Shared kernel: only for tiny value types, versioned as a package, with explicit owners.`,
  dia: r`flowchart LR
  TC[Trade Capture] -->|OHS + Published Language: trade events| ST[Settlement]
  ST -->|Customer-Supplier| LG[Ledger]
  RD[Reference Data] -->|Conformist| TC
  RD -->|Conformist| ST
  ST -->|ACL| CSD[Custodian legacy system]
  TC -->|Shared Kernel: Money, Isin| RK[Risk and Limits]`,
  code: r`~~~csharp
// Published language: a versioned integration contract owned by the upstream context
namespace TradeCapture.Contracts.V2;
public sealed record TradeBooked(
    Guid TradeId, string Isin, string Side, decimal Quantity, decimal Price, string Currency,
    DateOnly TradeDate, DateOnly SettlementDate, string Counterparty, int SchemaVersion = 2);

// Shared kernel: tiny, stable, versioned package with named owners
// <PackageReference Include="Bank.SharedKernel.Money" Version="3.1.0" />

// Conformist: Settlement uses reference-data shapes directly (accepted dependency)
public sealed class SettlementDateCalculator(IReferenceDataClient refData)
{
    public async Task<DateOnly> ForAsync(string isin, DateOnly tradeDate, CancellationToken ct)
    {
        var instrument = await refData.GetInstrumentAsync(isin, ct);          // upstream model used as is
        return await refData.AddBusinessDaysAsync(instrument.Market, tradeDate, instrument.SettlementCycleDays, ct);
    }
}
~~~`,
  pts: [r`Each pattern describes a technical and a team relationship.`, r`ACL protects your model from legacy and vendors.`, r`OHS + published language for one-to-many integration between your contexts.`, r`Shared kernel only for tiny stable types with owners.`, r`Context maps make Conway's Law explicit.`],
  ex: r`A payments team was conformist to a core-banking vendor's account model; every vendor upgrade broke their domain logic. Introducing an ACL and an internal account model reduced the next upgrade's impact to one adapter.`,
  fu: [r`How do you move from conformist to ACL without stopping delivery?`, r`When is separate ways the right call?`, r`How do you version a published language?`],
  pit: [r`Shared kernels that keep growing.`, r`Undocumented upstream/downstream relationships.`, r`Conformist relationships with vendors in core domains.`] },

{ id: 'q9', level: 'Intermediate', tags: ['ddd', 'anti-corruption-layer', 'legacy', 'integration'],
  q: r`Design an anti-corruption layer between your payments context and a legacy core-banking system: what it translates, where it lives, how it handles failures and unknown values, and how you test it.`,
  a: r`### Purpose
Keep the legacy model (codes, cents as strings, overloaded fields, batch semantics) **out** of your domain, and make the legacy system replaceable.

### Components
- **Port** in your domain/application language ({{IAccountDirectory}}, {{IPostingGateway}}).
- **Adapter** in infrastructure implementing the port: client, DTOs mirroring the legacy API.
- **Translator**: maps codes and units to your value objects and enums; maps your commands to legacy requests.
- **Facade** where the legacy API is chatty (combine three calls into one port method).

### Semantics, not just fields
- Status codes ({{"A"}}, {{"F"}}, {{"C"}}) to domain states; **unknown codes fail loudly** (exception plus alert), never default silently.
- Units: cents as strings to {{Money}}; local times to UTC with the legacy system's time zone.
- Error codes to domain outcomes ({{InsufficientFunds}}, {{AccountBlocked}}) vs technical failures (retryable).
- Batch or eventually consistent behaviour (postings visible next day) surfaced honestly in the port's contract.

### Resilience
Timeouts, retries with idempotency keys where the legacy system supports them (or a dedupe table you maintain), a circuit breaker, and caching for slow reference lookups.

### Testing
- Contract tests against recorded legacy responses (golden files), including weird ones.
- Translator unit tests for every code.
- A sandbox integration test run nightly.`,
  code: r`~~~csharp
// Port in our language
public interface IAccountDirectory
{
    Task<AccountSnapshot> GetAsync(AccountId id, CancellationToken ct);
}

// Adapter + translator in infrastructure
internal sealed class CoreBankingAccountDirectory(ICoreBankingClient client, ILogger<CoreBankingAccountDirectory> log) : IAccountDirectory
{
    private static readonly TimeZoneInfo CoreTz = TimeZoneInfo.FindSystemTimeZoneById("Europe/London");

    public async Task<AccountSnapshot> GetAsync(AccountId id, CancellationToken ct)
    {
        var raw = await client.GetAcctAsync(id.Value.ToString("N"), ct);          // legacy: ACCT_STAT codes, cents as strings
        var status = raw.AcctStat switch
        {
            "A" => AccountStatus.Active,
            "F" => AccountStatus.Frozen,
            "C" => AccountStatus.Closed,
            "D" => AccountStatus.Dormant,
            _ => throw new UnknownLegacyCodeException("ACCT_STAT", raw.AcctStat)  // fail loudly, alert
        };
        var balance = Money.FromMinorUnits(long.Parse(raw.AvailBalCents, CultureInfo.InvariantCulture), raw.Ccy);
        var asOf = TimeZoneInfo.ConvertTimeToUtc(DateTime.ParseExact(raw.BalTs, "yyyyMMddHHmmss", CultureInfo.InvariantCulture), CoreTz);
        return new AccountSnapshot(id, status, balance, new DateTimeOffset(asOf));
    }
}

// Golden-file contract test of the translator
[Theory]
[InlineData("acct_active.json", AccountStatus.Active, 12345)]
[InlineData("acct_dormant.json", AccountStatus.Dormant, 0)]
public async Task Translates_legacy_accounts(string file, AccountStatus status, long cents)
{
    var sut = new CoreBankingAccountDirectory(FakeClient.FromFile(file), NullLogger<CoreBankingAccountDirectory>.Instance);
    var snap = await sut.GetAsync(TestIds.Account, default);
    Assert.Equal(status, snap.Status);
    Assert.Equal(Money.FromMinorUnits(cents, "GBP"), snap.Available);
}
~~~`,
  pts: [r`Port in your language, adapter plus translator in infrastructure.`, r`Translate semantics: codes, units, time zones, error meanings.`, r`Unknown legacy values fail loudly.`, r`Resilience: timeouts, idempotency, circuit breakers, caching.`, r`Golden-file contract tests and nightly sandbox tests.`],
  ex: r`A legacy system introduced a new status "R" (restricted) without notice; the old integration defaulted unknown codes to Active and allowed payments from restricted accounts for two days. The ACL's fail-loud rule turned the next unknown code into an alert within minutes.`,
  fu: [r`Where should the ACL live if three contexts integrate with the same legacy system?`, r`How do you handle a legacy system without idempotency?`, r`How does an ACL help a later migration off the legacy system?`],
  pit: [r`Legacy DTOs leaking into the domain.`, r`Defaulting unknown codes.`, r`Translating fields but not semantics.`] },

{ id: 'q10', level: 'Intermediate', tags: ['ddd', 'aggregates', 'invariants', 'design'],
  q: r`Worked design: customers have a credit limit; orders must not push outstanding exposure above it. Where do you put the aggregate boundaries, and what do you do when the invariant spans many orders?`,
  a: r`### Find the invariant precisely
"The **sum of outstanding exposure** for a customer must not exceed the credit limit **at the moment an order is submitted**." That rule involves **all** open orders of the customer, not one order.

### Options
1. **Customer aggregate containing all orders**: enforces the rule atomically but becomes huge and a contention hot spot (every order of a busy customer conflicts). Rejected.
2. **Order aggregate checks a read model**: race condition: two concurrent orders both see room and both pass. Acceptable only if the business tolerates small overshoots.
3. **A small CreditLine (or Exposure) aggregate per customer** holding the limit and the **reserved exposure**: submitting an order **reserves** exposure on the CreditLine first (one small aggregate, one transaction), then the order is submitted. Release on cancellation or settlement. This keeps the invariant in one small consistency boundary.
4. Process across both: a policy reacts to {{OrderSubmitted}} by reserving; on failure, the order is rejected (eventual consistency with compensation).

### Choose by business tolerance
- Hard limit (regulatory, credit risk) → option 3, reservation before acceptance, synchronous.
- Soft limit (alerting) → option 2 or 4 with monitoring.

### General lessons
- The boundary is **the invariant**, not the noun.
- If two aggregates must change atomically, either the rule belongs to a smaller dedicated aggregate, or the business can accept eventual consistency, or the boundary is wrong.
- Ask "what happens if this rule is violated for 2 seconds?" Experts often tolerate more than engineers assume.`,
  code: r`~~~csharp
// Small aggregate that owns the cross-order invariant
public sealed class CreditLine : AggregateRoot<CustomerId>
{
    public Money Limit { get; private set; }
    public Money Reserved { get; private set; }
    private readonly Dictionary<OrderId, Money> _reservations = new();

    public void Reserve(OrderId order, Money amount)
    {
        if (_reservations.ContainsKey(order)) return;                         // idempotent
        if (Reserved.Add(amount) > Limit) throw new CreditLimitExceededException(Id, Limit, Reserved, amount);
        _reservations[order] = amount;
        Reserved = Reserved.Add(amount);
        Raise(new CreditReserved(Id, order, amount));
    }

    public void Release(OrderId order)
    {
        if (_reservations.Remove(order, out var amount)) { Reserved = Reserved.Subtract(amount); Raise(new CreditReleased(Id, order, amount)); }
    }
}

// Application service: reserve first (one aggregate, one transaction), then submit the order
public async Task SubmitAsync(OrderId id, CancellationToken ct)
{
    var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException();
    var credit = await creditLines.GetAsync(order.CustomerId, ct);
    credit.Reserve(order.Id, order.Total);
    await uow.SaveChangesAsync(ct);                 // rowversion on CreditLine serialises concurrent reservations

    order.Submit();                                 // second transaction; on failure a policy releases the reservation
    await uow.SaveChangesAsync(ct);
}
~~~`,
  pts: [r`State the invariant precisely; the boundary follows the invariant.`, r`Avoid giant aggregates that contain every related object.`, r`Read-model checks race; small dedicated aggregates with reservations do not.`, r`Pick strict vs eventual consistency by business tolerance.`, r`Atomic changes to two aggregates usually signal a missing aggregate or a wrong boundary.`],
  ex: r`A B2B ordering platform modelled Customer with all orders inside it; large customers placed 50 orders per minute and 30% failed with concurrency conflicts. A separate CreditLine aggregate with reservations cut conflicts to near zero and kept the hard limit.`,
  fu: [r`How do you release reservations for orders that are never submitted?`, r`What if the limit changes while reservations exist?`, r`How would you handle a credit line shared by a group of companies?`],
  pit: [r`Putting everything related into one aggregate.`, r`Enforcing hard limits from stale read models.`, r`Assuming every rule must be immediately consistent.`] },

{ id: 'q11', level: 'Intermediate', tags: ['ddd', 'domain-services', 'application-services', 'validation'],
  q: r`Domain service vs application service vs logic in the aggregate: where does each kind of rule go, and where does validation belong (input, invariants, cross-aggregate rules, authorization)?`,
  a: r`### Placement
| Logic | Home |
|---|---|
| Rules about one aggregate's own state | **methods on the aggregate / value objects** |
| Domain logic spanning several aggregates or needing domain policies (fees, FX conversion, transfer rules) | **domain service**: stateless, named in the language, no I/O ideally (receives data or domain interfaces) |
| Use-case orchestration: load, call domain, save, publish, transactions, authorization | **application service / command handler**: **no business rules** |
| Technical concerns (HTTP, SQL, messaging) | infrastructure adapters |

### Validation layers
1. **Input/format** at the edge: required fields, formats, ranges (FluentValidation or minimal API filters). Rejects garbage early with 400s.
2. **Invariants** in aggregates and value objects: always enforced, whoever calls.
3. **Cross-aggregate or external-data rules**: domain services or the application service gathers data (sanctions list, limits) and passes it to the domain.
4. **Authorization** in the application layer (who may do this to this resource), not in entities.

### Smells
- Application services full of if-statements about business rules → anemic domain.
- Domain services that are really "EntityManager" classes holding all logic.
- Aggregates calling repositories or HTTP clients.`,
  code: r`~~~csharp
// Domain service: business logic across two aggregates' data, no infrastructure
public sealed class FeeCalculator(IFeeSchedule schedule)
{
    public Money FeeFor(Payment payment, Merchant merchant) =>
        schedule.RateFor(merchant.Tier, payment.Method, payment.Amount.Currency).Apply(payment.Amount);
}

// Application service: orchestration only
public sealed class CapturePaymentHandler(IPaymentRepository payments, IMerchantRepository merchants,
                                          FeeCalculator fees, IAuthorizationService authz, IUnitOfWork uow, ICurrentUser user)
{
    public async Task<Result> Handle(CapturePayment cmd, CancellationToken ct)
    {
        var payment = await payments.GetAsync(cmd.PaymentId, ct);
        if (payment is null) return Result.NotFound();
        if (!await authz.CanCaptureAsync(user, payment.MerchantId, ct)) return Result.Forbidden();   // authorization here
        var merchant = await merchants.GetAsync(payment.MerchantId, ct);
        payment.Capture(cmd.Amount, fees.FeeFor(payment, merchant));                                 // rules in the domain
        await uow.SaveChangesAsync(ct);                                                              // events -> outbox
        return Result.Ok();
    }
}

// Input validation at the edge
public sealed class CapturePaymentValidator : AbstractValidator<CapturePaymentRequest>
{
    public CapturePaymentValidator()
    {
        RuleFor(x => x.Amount).GreaterThan(0);
        RuleFor(x => x.Currency).Length(3);
    }
}
~~~`,
  pts: [r`Single-aggregate rules on the aggregate; multi-aggregate domain logic in domain services.`, r`Application services orchestrate and authorize; no business rules.`, r`Input validation at the edge; invariants always in the domain.`, r`Gather external data in the application layer, pass it to the domain.`, r`Domain objects never call repositories or HTTP clients.`],
  ex: r`A refund feature had its "refund cannot exceed captured minus previous refunds" rule in the API controller; a back-office tool calling the same repository directly bypassed it and refunded twice. Moving the rule into Payment.Refund made every path enforce it.`,
  fu: [r`Can a domain service call a repository?`, r`Where does a rule that needs current FX rates go?`, r`How do you return validation errors from deep inside the domain to HTTP?`],
  pit: [r`Business rules in controllers or handlers.`, r`Entities with injected services.`, r`Authorization logic in entities.`] },

{ id: 'q12', level: 'Intermediate', tags: ['ddd', 'repositories', 'ef-core', 'persistence'],
  q: r`Repositories in DDD with EF Core: what should a repository expose, why not a generic IRepository<T>, and how do you map a rich, encapsulated domain model (private setters, private collections, value objects, typed ids)?`,
  a: r`### What a repository is
Collection-like access to **aggregates**, one repository per **aggregate root**: {{GetAsync(id)}}, {{Add}}, sometimes {{Remove}} or a few domain-meaningful finders. It returns **whole, consistent aggregates**. Screen queries and reports do **not** go through repositories: use query objects or read models (CQRS).

### Why not a generic repository
{{IRepository<T>}} with {{IQueryable<T> Query()}} leaks persistence into callers, allows partial loads of aggregates, and duplicates what {{DbContext}} already is (unit of work + repositories). It adds a layer without adding meaning.

### Mapping a rich model without polluting it
- **Private setters** and **backing fields**: EF maps them.
- A **private parameterless constructor** for materialisation.
- **Private collections** exposed as {{IReadOnlyCollection}}: {{Navigation(...).UsePropertyAccessMode(PropertyAccessMode.Field)}}.
- **Value objects** as complex types or owned types; **strongly typed ids** with value converters.
- **Concurrency token** on the root.
- **Ignore** the domain-event list.
- All configuration in {{IEntityTypeConfiguration}} classes in infrastructure: no EF attributes in the domain.

### Unit of work
Application services call {{IUnitOfWork.SaveChangesAsync}} (the DbContext) once per use case; the save also converts domain events to outbox rows.`,
  code: r`~~~csharp
public interface IOrderRepository
{
    Task<Order?> GetAsync(OrderId id, CancellationToken ct);
    void Add(Order order);
}

internal sealed class OrderRepository(OrderingDbContext db) : IOrderRepository
{
    public Task<Order?> GetAsync(OrderId id, CancellationToken ct) =>
        db.Orders.Include(o => o.Lines).SingleOrDefaultAsync(o => o.Id == id, ct);   // whole aggregate, tracked
    public void Add(Order order) => db.Orders.Add(order);
}

internal sealed class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> b)
    {
        b.ToTable("Orders", "ordering");
        b.HasKey(o => o.Id);
        b.Property(o => o.Id).HasConversion(id => id.Value, v => new OrderId(v));
        b.Property(o => o.CustomerId).HasConversion(id => id.Value, v => new CustomerId(v));
        b.OwnsMany(o => o.Lines, l =>
        {
            l.ToTable("OrderLines", "ordering");
            l.WithOwner().HasForeignKey("OrderId");
            l.ComplexProperty(x => x.UnitPrice);
        });
        b.Navigation(o => o.Lines).UsePropertyAccessMode(PropertyAccessMode.Field);
        b.Property(o => o.RowVersion).IsRowVersion();
        b.Ignore(o => o.DomainEvents);
    }
}

// Screen query: not a repository; projection straight from the DbContext
public sealed class OrderListQuery(OrderingDbContext db)
{
    public Task<List<OrderRow>> RunAsync(CustomerId c, CancellationToken ct) =>
        db.Orders.AsNoTracking().Where(o => o.CustomerId == c)
          .Select(o => new OrderRow(o.Id.Value, o.Status.ToString(), o.Lines.Count)).ToListAsync(ct);
}
~~~`,
  pts: [r`One repository per aggregate root, returning whole aggregates.`, r`No generic IRepository<T> leaking IQueryable.`, r`Queries for screens bypass repositories (CQRS read side).`, r`EF maps private setters, fields, owned/complex types and typed ids from infrastructure configs.`, r`One SaveChanges per use case; events to outbox in the same save.`],
  ex: r`A team's generic repository exposed IQueryable; developers loaded Orders without Lines, added lines through a separate DbSet, and the Order total invariant broke. Aggregate-specific repositories that always load the full aggregate removed the bypass.`,
  fu: [r`How do you avoid N+1 when processing 1,000 aggregates in a batch?`, r`Should repositories return IEnumerable for lists of aggregates?`, r`How do you test repositories?`],
  pit: [r`Generic repositories.`, r`Screen queries through aggregate repositories.`, r`EF attributes in domain classes.`] },

{ id: 'q13', level: 'Intermediate', tags: ['ddd', 'domain-events', 'integration-events', 'outbox'],
  q: r`Domain events vs integration events: who raises them, when are they dispatched (before or after commit), how do they reach other contexts reliably, and how do you keep internal events from becoming public contracts?`,
  a: r`### Domain events
An internal fact in the ubiquitous language ({{OrderSubmitted}}), **raised by aggregates**, handled **inside the same bounded context** to trigger side effects on other aggregates or policies. Free to change with the model.

### Integration events
A **published contract** for other contexts ({{Ordering.V1.OrderSubmitted}}): minimal, versioned, stable, documented. Produced by **translating** domain events at the boundary.

### Dispatch timing
| Option | Pros | Cons |
|---|---|---|
| **Before commit**, in the same transaction | atomic with the change | grows the transaction, couples handlers, handler failure rolls back the use case |
| **After commit**, from the outbox | small transactions, retries, idempotent handlers | eventual consistency; handlers must be idempotent |

Rule: in-context handlers that must be atomic and are cheap may run before commit; **anything crossing a context or doing I/O goes after commit via the outbox**.

### Reliable delivery
Aggregates collect events; a {{SaveChangesInterceptor}} maps them to integration events and inserts **outbox rows in the same transaction**; a relay publishes at least once; consumers dedupe (inbox). Never publish to a broker from inside an aggregate or before commit.

### Keeping contracts clean
A separate **Contracts** project per context with explicit integration event types; mapping code from domain to contract; schema versioning and contract tests. Do not serialise domain events directly onto the bus.`,
  code: r`~~~csharp
public abstract class AggregateRoot<TId>(TId id) : IHasDomainEvents
{
    private readonly List<IDomainEvent> _events = [];
    public TId Id { get; protected set; } = id;
    public IReadOnlyCollection<IDomainEvent> DomainEvents => _events;
    protected void Raise(IDomainEvent e) => _events.Add(e);
    public void ClearEvents() => _events.Clear();
}

// Translate domain events to integration contracts and write them to the outbox atomically
public sealed class DomainEventsToOutbox : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData d, InterceptionResult<int> r, CancellationToken ct = default)
    {
        var db = d.Context!;
        foreach (var agg in db.ChangeTracker.Entries<IHasDomainEvents>().Select(e => e.Entity).Where(a => a.DomainEvents.Count > 0).ToList())
        {
            foreach (var e in agg.DomainEvents)
                if (IntegrationEventMapper.TryMap(e, out var contract))                   // only some events are public
                    db.Set<OutboxMessage>().Add(OutboxMessage.From(contract));
            agg.ClearEvents();
        }
        return base.SavingChangesAsync(d, r, ct);
    }
}

// Public contract: minimal, versioned, separate from the domain type
namespace Ordering.Contracts.V1
{
    public sealed record OrderSubmitted(Guid OrderId, Guid CustomerId, decimal Total, string Currency, DateTimeOffset SubmittedAt);
}
~~~`,
  pts: [r`Domain events are internal facts; integration events are versioned public contracts.`, r`Aggregates raise events; the unit of work dispatches them.`, r`Cross-context or I/O handlers run after commit via the outbox.`, r`Consumers are idempotent; delivery is at least once.`, r`Map domain events to separate contract types; never put domain types on the bus.`],
  ex: r`A team published domain events directly to Kafka; renaming a property inside the Order model broke four consuming teams in production. Introducing a contracts package with explicit mapping and contract tests let the domain evolve freely afterwards.`,
  fu: [r`How do you version integration events without breaking consumers?`, r`What is the inbox pattern?`, r`Should every domain event become an integration event?`],
  pit: [r`Publishing from inside aggregates.`, r`Domain events serialised as public contracts.`, r`Long synchronous handler chains inside one transaction.`] },

{ id: 'q14', level: 'Intermediate', tags: ['ddd', 'state-machines', 'lifecycle', 'payments'],
  q: r`Model the lifecycle of a card payment (authorised, partially captured, captured, refunded, voided, charged back) as an aggregate. How do you make illegal transitions impossible and keep the model readable?`,
  a: r`### Model the states and transitions explicitly
States: {{Authorised}}, {{PartiallyCaptured}}, {{Captured}}, {{PartiallyRefunded}}, {{Refunded}}, {{Voided}}, {{Expired}}, {{ChargedBack}}. Each command is a **method** that checks the current state and the amounts, changes state, and raises an event.

### Techniques
- **Guard clauses per method** with domain exceptions: simple and readable for a handful of states.
- An explicit **transition table** (allowed from-states per command) when states grow; makes the lifecycle reviewable by experts.
- **State pattern** (state objects) when behaviour differs heavily per state.
- Track **amounts as value objects** (authorised, captured, refunded) and derive the status from them where possible, rather than storing redundant flags that can disagree.
- Time-based transitions (authorisation expiry after 7 days) are commands raised by a scheduler, not hidden in getters.

### Invariants
- Captured ≤ authorised; refunded ≤ captured; same currency throughout.
- Void only before any capture; chargeback only after capture.
- Every transition raises an event (audit trail and integrations).

### Persistence
Store the status as a string (readable, safe to reorder), amounts as complex types, and a rowversion; consider the event history as the audit log or use event sourcing if regulators need full history.`,
  dia: r`stateDiagram-v2
  [*] --> Authorised
  Authorised --> PartiallyCaptured: capture partial
  Authorised --> Captured: capture full
  PartiallyCaptured --> Captured: capture remainder
  Authorised --> Voided: void
  Authorised --> Expired: expiry
  Captured --> PartiallyRefunded: refund partial
  PartiallyRefunded --> Refunded: refund remainder
  Captured --> Refunded: refund full
  Captured --> ChargedBack: chargeback`,
  code: r`~~~csharp
public sealed class CardPayment : AggregateRoot<PaymentId>
{
    public Money Authorised { get; private set; }
    public Money Captured { get; private set; }
    public Money Refunded { get; private set; }
    public PaymentStatus Status { get; private set; } = PaymentStatus.Authorised;

    private static readonly Dictionary<string, PaymentStatus[]> Allowed = new()
    {
        ["Capture"]    = [PaymentStatus.Authorised, PaymentStatus.PartiallyCaptured],
        ["Void"]       = [PaymentStatus.Authorised],
        ["Refund"]     = [PaymentStatus.Captured, PaymentStatus.PartiallyRefunded],
        ["Chargeback"] = [PaymentStatus.Captured, PaymentStatus.PartiallyRefunded],
    };
    private void Require(string command)
    {
        if (!Allowed[command].Contains(Status)) throw new InvalidTransitionException(command, Status);
    }

    public void Capture(Money amount)
    {
        Require("Capture");
        if (Captured.Add(amount) > Authorised) throw new DomainException("Capture exceeds authorisation");
        Captured = Captured.Add(amount);
        Status = Captured == Authorised ? PaymentStatus.Captured : PaymentStatus.PartiallyCaptured;
        Raise(new PaymentCaptured(Id, amount));
    }

    public void Refund(Money amount, RefundReason reason)
    {
        Require("Refund");
        if (Refunded.Add(amount) > Captured) throw new DomainException("Refund exceeds captured amount");
        Refunded = Refunded.Add(amount);
        Status = Refunded == Captured ? PaymentStatus.Refunded : PaymentStatus.PartiallyRefunded;
        Raise(new PaymentRefunded(Id, amount, reason));
    }

    public void Void() { Require("Void"); Status = PaymentStatus.Voided; Raise(new PaymentVoided(Id)); }
}
~~~`,
  pts: [r`One method per command: check state and amounts, transition, raise an event.`, r`Transition tables or state objects as the lifecycle grows.`, r`Derive status from amounts where possible; avoid contradictory flags.`, r`Time-based transitions are explicit commands from a scheduler.`, r`Every transition raises an event for audit and integration.`],
  ex: r`A PSP's payment table had seven boolean flags (isCaptured, isRefunded, ...); a race left 1,200 payments both voided and captured, and finance could not reconcile them. An aggregate with an explicit transition table and amount-based status made those states unrepresentable.`,
  fu: [r`How do you handle a capture notification that arrives after an expiry?`, r`When would you switch to the state pattern?`, r`How do you migrate the flag-based table to the new model?`],
  pit: [r`Boolean flags instead of states.`, r`Status setters callable from anywhere.`, r`Hidden time-based transitions in getters.`] },

{ id: 'q15', level: 'Intermediate', tags: ['ddd', 'anemic-model', 'transaction-script', 'rich-model'],
  q: r`Anemic domain model vs rich domain model vs transaction script: what is the actual problem with anemic models, when is a transaction script the right choice, and how do you refactor towards a rich model incrementally?`,
  a: r`### Anemic model
Entities with public getters and setters and no behaviour; all logic in "services". Problems:
- **Invariants are not enforced** by the objects: any code can put an entity into an invalid state.
- **Rules are duplicated** across services and drift apart.
- Business concepts are hidden in procedural code; tests need lots of setup.

### Transaction script
Procedural code per use case (load, compute, save), often with SQL. **Perfectly fine** for simple, CRUD-like or report-like logic, supporting and generic subdomains, and when rules are few and unlikely to grow. Calling that "anemic" is a category error: there is no rich behaviour to put in objects.

### Rich model
Behaviour and data together; invariants enforced in methods; value objects for concepts. Pays off when rules are numerous, interact, and change.

### Incremental refactoring
1. Pick a painful rule that is duplicated or bypassed.
2. **Move it into the entity** as a method; make the corresponding setters private.
3. Introduce value objects for primitive concepts (Money, dates ranges) as you touch code.
4. Make constructors enforce validity ("always valid").
5. Replace service code with calls to the new methods; add unit tests on the entity.
6. Repeat; let the model grow where change happens. Leave stable CRUD areas alone.`,
  code: r`~~~csharp
// Anemic: rules live in a service; any other code can bypass them
public class Loan { public decimal Balance { get; set; } public LoanStatus Status { get; set; } public decimal OverpaymentsThisYear { get; set; } }
public class LoanService
{
    public void Overpay(Loan loan, decimal amount)
    {
        if (loan.Status != LoanStatus.Active) throw new InvalidOperationException();
        if (loan.OverpaymentsThisYear + amount > loan.Balance * 0.10m) throw new InvalidOperationException("10% rule");
        loan.Balance -= amount; loan.OverpaymentsThisYear += amount;
    }
}

// Rich: the rule is part of the Loan and cannot be bypassed
public sealed class Loan : AggregateRoot<LoanId>
{
    public Money Balance { get; private set; }
    public LoanStatus Status { get; private set; }
    public Money OverpaidThisYear { get; private set; }
    private static readonly decimal FreeOverpaymentRate = 0.10m;

    public OverpaymentResult Overpay(Money amount, DateOnly on)
    {
        if (Status != LoanStatus.Active) throw new DomainException("Only active loans accept overpayments");
        var allowance = Balance.Multiply(FreeOverpaymentRate).Subtract(OverpaidThisYear);
        var charge = amount > allowance ? EarlyRepaymentCharge.For(amount.Subtract(allowance), on) : Money.Zero(amount.Currency);
        Balance = Balance.Subtract(amount);
        OverpaidThisYear = OverpaidThisYear.Add(amount);
        Raise(new LoanOverpaid(Id, amount, charge, on));
        return new OverpaymentResult(amount, charge);
    }
}
~~~`,
  pts: [r`Anemic models leave invariants unenforced and rules duplicated.`, r`Transaction scripts are right for simple logic; not every model needs richness.`, r`Rich models pay off where rules interact and change.`, r`Refactor incrementally: move one rule into the entity, privatise setters, add value objects.`, r`Leave stable CRUD areas alone.`],
  ex: r`A mortgage platform had the overpayment rule in three services (web, branch, batch) with three slightly different calculations; customers were charged inconsistently. Moving the rule into the Loan aggregate removed the discrepancy and cut related complaints to zero.`,
  fu: [r`Is a service with all the logic always wrong?`, r`How do you introduce private setters without breaking existing callers?`, r`How do ORMs push teams toward anemic models?`],
  pit: [r`Calling every transaction script "anemic".`, r`Big-bang rewrites to a rich model.`, r`Public setters kept "for convenience".`] },

{ id: 'q16', level: 'Intermediate', tags: ['ddd', 'always-valid', 'value-objects', 'serialization'],
  q: r`"Always-valid" domain objects: how do you guarantee invalid aggregates and value objects cannot exist, while still materialising them from the database, deserialising API input and returning good validation errors?`,
  a: r`### The principle
Constructors and factory methods **validate** and reject invalid state; methods preserve invariants; no public setters. Then any instance you hold is valid, and code does not need defensive checks everywhere.

### Tension points and solutions
| Situation | Solution |
|---|---|
| EF Core materialisation | private parameterless constructor and field mapping; EF bypasses public validation (trusted data from your own database) |
| API input | DTOs, not domain objects; validate DTOs, then construct domain objects |
| Collecting several validation errors | a {{TryCreate}} / {{Result<T>}} factory returning all errors, or validate the DTO first so domain exceptions indicate bugs |
| Legacy data that violates new rules | migrate data, or a separate "unverified" type, never relaxing the invariant silently |
| JSON serialisation of value objects | custom converters or primitives at the edge |

### Exceptions vs Result
- Domain **invariant violations** caused by callers that should have validated: exceptions (bugs or races).
- **Expected business outcomes** (insufficient funds, limit exceeded): a Result type or specific domain exceptions mapped to 409/422 by the application layer.
Pick one convention per codebase.

### Strongly typed ids and value objects at the edges
Keep primitives in DTOs; convert once in the application layer: {{new Iban(dto.Iban)}}.`,
  code: r`~~~csharp
public sealed record EmailAddress
{
    public string Value { get; }
    private EmailAddress(string v) => Value = v;

    public static Result<EmailAddress> Create(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return Result.Fail<EmailAddress>("email.required", "Email is required");
        var v = raw.Trim().ToLowerInvariant();
        if (!MailAddress.TryCreate(v, out _)) return Result.Fail<EmailAddress>("email.invalid", "Email is not valid");
        return Result.Ok(new EmailAddress(v));
    }
}

// Application layer: DTO -> value objects, collecting all errors
public async Task<IResult> RegisterAsync(RegisterRequest dto, CancellationToken ct)
{
    var email = EmailAddress.Create(dto.Email);
    var iban = Iban.Create(dto.Iban);
    var errors = Result.Combine(email, iban);
    if (errors.IsFailure) return Results.ValidationProblem(errors.ToDictionary());
    var customer = Customer.Register(CustomerId.New(), email.Value, iban.Value);   // always valid from here on
    customers.Add(customer);
    await uow.SaveChangesAsync(ct);
    return Results.Created($"/customers/{customer.Id.Value}", null);
}

// EF Core: private constructor + field access; no validation bypass in application code
internal sealed class CustomerConfiguration : IEntityTypeConfiguration<Customer>
{
    public void Configure(EntityTypeBuilder<Customer> b)
    {
        b.Property(c => c.Email).HasConversion(e => e.Value, v => EmailAddress.Create(v).Value).HasMaxLength(254);
    }
}
~~~`,
  pts: [r`Constructors and factories validate; no public setters: every instance is valid.`, r`EF materialises through private constructors and fields from trusted data.`, r`DTOs at the edge; convert to value objects once in the application layer.`, r`Result-style factories collect multiple errors for good API responses.`, r`One convention for exceptions vs results across the codebase.`],
  ex: r`A CRM allowed customers with invalid emails because validation happened only in the web form; an import path created 40,000 invalid records that broke the statement-mailing job. An always-valid EmailAddress type made the import reject bad rows with clear errors.`,
  fu: [r`What do you do with legacy rows that violate a new invariant?`, r`Should value objects throw or return results?`, r`How do you map domain errors to ProblemDetails?`],
  pit: [r`Domain objects bound directly from JSON.`, r`Public setters for serialisers.`, r`Silently relaxing invariants for legacy data.`] },

{ id: 'q17', level: 'Intermediate', tags: ['ddd', 'factories', 'specifications', 'policies'],
  q: r`When do you use factories, specifications and policies in a domain model? Show a specification reused for in-memory checks and EF Core queries.`,
  a: r`### Factories
Encapsulate **complex creation**: when building an aggregate needs several steps, data from other sources, or enforces creation-time rules (a loan created from an approved application with the right schedule).
- A **static factory method** on the aggregate ({{Loan.OpenFrom(application, schedule)}}) for most cases.
- A **factory service** when creation needs domain services or reference data.
Factories give names to creation in the ubiquitous language and keep constructors simple.

### Specifications
A named, reusable **business predicate** ({{OverdueInvoice}}, {{HighRiskPayment}}). Uses:
1. Validation: does this object satisfy the rule?
2. Selection: query objects that satisfy it.
3. Building: create objects to satisfy it (rare).
Implemented as an {{Expression<Func<T,bool>>}} so the same rule runs in memory ({{Compile()}}) and translates to SQL via EF Core. Compose with And/Or.

### Policies
Strategy objects for business rules that vary (fee policies per merchant tier, late-fee policy per product, rounding policy per currency). Selected by configuration or context, unit-testable, named in the language.

### Warning
Do not wrap every one-line condition in a specification. Use them for rules that are **named by the business**, reused, or likely to change.`,
  code: r`~~~csharp
// Specification usable in memory and in EF Core queries
public sealed class OverdueInvoice(DateOnly asOf, int graceDays)
{
    public Expression<Func<Invoice, bool>> ToExpression()
    {
        var cutoff = asOf.AddDays(-graceDays);
        return i => i.Status == InvoiceStatus.Open && i.DueDate < cutoff;
    }
    private Func<Invoice, bool>? _compiled;
    public bool IsSatisfiedBy(Invoice i) => (_compiled ??= ToExpression().Compile())(i);
}

var spec = new OverdueInvoice(today, graceDays: 5);
var overdue = await db.Invoices.Where(spec.ToExpression()).ToListAsync(ct);       // SQL
if (spec.IsSatisfiedBy(invoice)) invoice.ApplyLateFee(lateFeePolicy.FeeFor(invoice));  // in memory

// Factory method expressing creation rules in the language
public sealed partial class Loan
{
    public static Loan OpenFrom(CreditApplication app, RepaymentSchedule schedule, DateOnly disbursedOn)
    {
        if (app.Status != ApplicationStatus.Approved) throw new DomainException("Only approved applications become loans");
        if (schedule.Principal != app.ApprovedLimit) throw new DomainException("Schedule principal must equal approved amount");
        var loan = new Loan(LoanId.New(), app.Applicant, schedule, disbursedOn);
        loan.Raise(new LoanOpened(loan.Id, app.Id, schedule.Principal));
        return loan;
    }
}

// Policy: varies by product, selected by configuration
public interface ILateFeePolicy { Money FeeFor(Invoice invoice); }
public sealed class FlatLateFee(Money fee) : ILateFeePolicy { public Money FeeFor(Invoice _) => fee; }
public sealed class PercentLateFee(decimal pct, Money cap) : ILateFeePolicy
{
    public Money FeeFor(Invoice i) => Money.Min(i.Outstanding.Multiply(pct), cap);
}
~~~`,
  pts: [r`Factories name and enforce complex creation.`, r`Specifications are named business predicates reused for checks and queries.`, r`Expression-based specifications translate to SQL and compile for memory.`, r`Policies encapsulate varying rules as strategies.`, r`Only for business-named, reused or changing rules.`],
  ex: r`Overdue logic existed in a dashboard query, a dunning job and an API filter with three different grace-period rules; customers received reminders for invoices the portal showed as current. A single OverdueInvoice specification used by all three ended the mismatch.`,
  fu: [r`How do you compose specifications with And/Or for EF Core?`, r`When is a factory service better than a static method?`, r`How do you configure policies per tenant?`],
  pit: [r`Specifications for trivial conditions.`, r`Duplicated business predicates in queries.`, r`Constructors doing complex orchestration.`] },

{ id: 'q18', level: 'Intermediate', tags: ['ddd', 'testing', 'unit-tests', 'given-when-then'],
  q: r`How do you test a rich domain model? Cover aggregate unit tests, event-based given-when-then tests, property-based tests for invariants, and what not to mock.`,
  a: r`### Aggregate unit tests
Fast, no infrastructure: create the aggregate in a state, call a method, assert **state** and **raised events** (or the exception). Name tests in the ubiquitous language so experts can read them.

### Given-when-then with events
- **Given** a history (events or a builder that reaches a state), **when** a command method runs, **then** expect events or a domain error. This style survives refactoring of internal fields and mirrors Event Storming outputs.

### Property-based tests
For invariants over many inputs: "for any sequence of captures and refunds, refunded ≤ captured ≤ authorised", "money arithmetic never mixes currencies". FsCheck or CsCheck generate inputs and shrink failures to minimal cases.

### Test data builders
Builders ({{Payments.Authorised(100)}}) keep tests short and expressive; avoid giant shared fixtures.

### What not to mock
- Value objects and entities: use real ones.
- Domain services that are pure: use real ones.
Mock (or fake) only **ports** to the outside world in application-service tests.

### Above the domain
Application services: tests with fake repositories or an in-memory unit of work, or integration tests with a real database (Testcontainers) for mapping and concurrency. Contract tests for integration events.`,
  code: r`~~~csharp
public class CardPaymentTests
{
    [Fact]
    public void Partial_capture_leaves_payment_partially_captured()
    {
        var p = Payments.Authorised(Money.Gbp(100));
        p.Capture(Money.Gbp(40));
        Assert.Equal(PaymentStatus.PartiallyCaptured, p.Status);
        var e = Assert.Single(p.DomainEvents.OfType<PaymentCaptured>());
        Assert.Equal(Money.Gbp(40), e.Amount);
    }

    [Fact]
    public void Cannot_refund_more_than_captured()
    {
        var p = Payments.Captured(Money.Gbp(100));
        var ex = Assert.Throws<DomainException>(() => p.Refund(Money.Gbp(101), RefundReason.CustomerRequest));
        Assert.Contains("exceeds captured", ex.Message);
    }

    // Property-based: invariant holds for any operation sequence (CsCheck)
    [Fact]
    public void Refunded_never_exceeds_captured_never_exceeds_authorised() =>
        Gen.Select(Gen.Decimal[1, 1000], Gen.Decimal[0, 1000].Array[0, 20])
           .Sample((auth, amounts) =>
           {
               var p = Payments.Authorised(Money.Gbp(Math.Round(auth, 2)));
               foreach (var a in amounts)
               {
                   var m = Money.Gbp(Math.Round(a, 2));
                   try { if (a % 2 == 0) p.Capture(m); else p.Refund(m, RefundReason.CustomerRequest); } catch (DomainException) { }
               }
               return p.Refunded.Amount <= p.Captured.Amount && p.Captured.Amount <= p.Authorised.Amount;
           });
}
~~~`,
  pts: [r`Aggregate tests are fast, infrastructure-free and named in the language.`, r`Assert state and raised events; given-when-then mirrors the model.`, r`Property-based tests verify invariants over many sequences.`, r`Use real value objects and entities; fake only ports.`, r`Integration tests for mappings, concurrency and contracts.`],
  ex: r`A property-based test on a loan schedule found that a combination of payment holidays and overpayments left a negative final instalment, a case none of the 300 example-based tests covered. The fix shipped before the product launch.`,
  fu: [r`How do you test domain event handlers?`, r`When do builders become a maintenance burden?`, r`How do you test that an aggregate is safe under concurrent updates?`],
  pit: [r`Mocking entities and value objects.`, r`Tests that assert private fields.`, r`Only database-backed tests for domain rules.`] },

{ id: 'q19', level: 'Senior', tags: ['ddd', 'aggregates', 'contention', 'performance'],
  q: r`A Wallet aggregate holding the balance and every transaction has become slow and a concurrency hot spot. Diagnose the design problem and redesign it.`,
  a: r`### Symptoms
- Loading a wallet loads years of transactions (memory, latency).
- Every top-up, payment and refund updates the same root: optimistic-concurrency conflicts and retries climb with traffic.
- Some wallets (merchants, payroll accounts) receive hundreds of operations per second.

### Diagnosis
The aggregate includes data that is **not needed to protect the invariant**. The invariant is "available balance never below zero (or the overdraft limit)"; the transaction history is not needed to enforce it.

### Redesign
1. **Small Wallet aggregate**: balance, available amount, limits, status, version. Nothing else.
2. **Transactions** become an **append-only ledger** (separate entities or a separate aggregate per transaction), written in the same transaction as the balance change or derived from events.
3. **History** and statements come from a **read model**, not from the aggregate.
4. **Hot wallets**:
   - credits do not need the balance check: append ledger entries and fold them into the balance periodically or asynchronously;
   - split the balance into **sub-balances** (shards) that sum to the total, debiting one shard;
   - or use **reservations** (holds) so authorisation is a cheap, separate step.
5. Use **atomic guarded updates** for simple debits instead of load-modify-save.

### General lesson
Aggregates are sized by **invariants and contention**, not by "what belongs together conceptually". History, statistics and derived totals belong in projections.`,
  code: r`~~~csharp
// Before: invariant + history + statistics in one root
public sealed class WalletBefore : AggregateRoot<WalletId>
{
    public List<WalletTransaction> Transactions { get; } = [];   // 2 million rows for a merchant
    public decimal Balance => Transactions.Sum(t => t.Amount);
}

// After: small root protecting only the invariant
public sealed class Wallet : AggregateRoot<WalletId>
{
    public Money Available { get; private set; }
    public Money OverdraftLimit { get; private set; }
    public WalletStatus Status { get; private set; }

    public LedgerEntry Debit(Money amount, PaymentRef reference)
    {
        if (Status != WalletStatus.Active) throw new DomainException("Wallet not active");
        if (Available.Subtract(amount) < OverdraftLimit.Negate()) throw new InsufficientFundsException(Id, amount);
        Available = Available.Subtract(amount);
        Raise(new WalletDebited(Id, amount, reference));
        return LedgerEntry.Debit(Id, amount, reference);              // separate append-only record, same transaction
    }
}

// Credits on a hot merchant wallet: append only, no root update on the hot path
db.LedgerEntries.Add(LedgerEntry.Credit(walletId, amount, reference));
await db.SaveChangesAsync(ct);
// A per-wallet folder process periodically adds unapplied credits to Available in one update

// Statement: read model, not the aggregate
var statement = await readDb.WalletStatementLines.Where(l => l.WalletId == id && l.BookedUtc >= from)
    .OrderByDescending(l => l.BookedUtc).Take(100).ToListAsync(ct);
~~~`,
  pts: [r`Large aggregates cost load time and create contention.`, r`Keep only data needed for the invariant in the aggregate.`, r`History goes to append-only ledgers and read models.`, r`Hot aggregates: append-only credits, sharded balances, reservations, guarded updates.`, r`Size aggregates by invariants and contention, not by conceptual grouping.`],
  ex: r`A payroll provider's employer wallet aggregate included all salary payments; on payday, 30% of payment commands failed with concurrency conflicts and retries pushed the run past the bank cut-off. The small Wallet plus append-only ledger finished the same run in 12 minutes.`,
  fu: [r`How do you guarantee the ledger and the balance never disagree?`, r`How do sharded sub-balances handle a debit larger than any single shard?`, r`When is eventual folding of credits unacceptable?`],
  pit: [r`Collections that grow without bound inside aggregates.`, r`Computing balances from full history on every load.`, r`Retrying conflicts instead of fixing the boundary.`] },

{ id: 'q20', level: 'Senior', tags: ['ddd', 'eventual-consistency', 'process-manager', 'policies'],
  q: r`A business rule spans several aggregates ("when an order is submitted, reserve stock and charge the customer; if stock fails, cancel the order"). How do you implement it with eventual consistency, policies and process managers, and how do you explain the trade-off to the business?`,
  a: r`### Why not one transaction
Order, Inventory and Payment are separate aggregates (often separate contexts). One transaction across them creates large locks, couples contexts, and does not scale or survive service boundaries.

### Building blocks
- **Policy** (reaction): "whenever {{OrderSubmitted}}, reserve stock": a stateless event handler issuing a command.
- **Process manager** (stateful orchestrator): tracks the progress of one business process instance (order 42: stock reserved? payment captured?), decides the next command, handles timeouts and **compensations**. Persisted, idempotent, keyed by the process id.
- **Choreography**: each context reacts to the others' events; no central coordinator. Simpler for 2 to 3 steps, harder to follow beyond that.

### Failure handling
- Compensation commands: release stock, refund payment, cancel order; designed in the domain language ({{CancelOrder(reason: OutOfStock)}}), not as technical rollbacks.
- Timeouts: if no {{StockReserved}} within 2 minutes, compensate.
- Idempotency: every step tolerates redelivery.

### Explaining it to the business
Ask: "what happens if, for 3 seconds, the order is submitted but stock is not yet reserved?" Usually: nothing harmful, the customer sees "processing". Then define what the customer sees during and after failure (an email, a cancelled order), which is a **product decision**, not a technical detail.

### When it must be immediate
If a rule cannot tolerate any window (regulatory limit), move it into **one** aggregate or synchronously reserve in the authoritative context before accepting the command.`,
  dia: r`sequenceDiagram
  participant O as Ordering
  participant PM as Order process manager
  participant I as Inventory
  participant P as Payments
  O->>PM: OrderSubmitted
  PM->>I: ReserveStock
  I-->>PM: StockReserved
  PM->>P: CapturePayment
  P-->>PM: PaymentFailed
  PM->>I: ReleaseStock
  PM->>O: CancelOrder reason PaymentFailed`,
  code: r`~~~csharp
public sealed class OrderFulfilmentProcess : AggregateRoot<OrderId>        // persisted process state
{
    public ProcessStep Step { get; private set; } = ProcessStep.Started;
    public DateTimeOffset Deadline { get; private set; }

    public IEnumerable<ICommand> Handle(OrderSubmitted e, DateTimeOffset now)
    {
        Deadline = now.AddMinutes(2);
        Step = ProcessStep.ReservingStock;
        yield return new ReserveStock(e.OrderId, e.Lines);
    }

    public IEnumerable<ICommand> Handle(StockReserved e)
    {
        if (Step != ProcessStep.ReservingStock) yield break;                  // idempotent / out of order
        Step = ProcessStep.CapturingPayment;
        yield return new CapturePayment(e.OrderId, e.Total);
    }

    public IEnumerable<ICommand> Handle(PaymentFailed e)
    {
        if (Step != ProcessStep.CapturingPayment) yield break;
        Step = ProcessStep.Compensating;
        yield return new ReleaseStock(e.OrderId);
        yield return new CancelOrder(e.OrderId, CancellationReason.PaymentFailed);
    }

    public IEnumerable<ICommand> OnTimeout(DateTimeOffset now)
    {
        if (now < Deadline || Step is ProcessStep.Completed or ProcessStep.Compensating) yield break;
        Step = ProcessStep.Compensating;
        yield return new CancelOrder(Id, CancellationReason.Timeout);
    }
}
~~~`,
  pts: [r`Cross-aggregate rules use eventual consistency, not one transaction.`, r`Policies react statelessly; process managers track state, timeouts and compensations.`, r`Compensations are domain commands with business meaning.`, r`Everything idempotent and tolerant of out-of-order messages.`, r`The inconsistency window and failure UX are business decisions.`],
  ex: r`An e-commerce team wrapped order, stock and payment in one distributed transaction; during a payment-provider slowdown, stock rows stayed locked and the catalogue showed items out of stock for 20 minutes. A process manager with compensation removed the locks, and the business chose to show "processing" for up to 30 seconds.`,
  fu: [r`Orchestration vs choreography: when do you switch?`, r`How do you handle a compensation that itself fails?`, r`How do you show the process status to customers?`],
  pit: [r`Distributed transactions across contexts.`, r`Compensations treated as technical rollbacks.`, r`No timeouts on waiting steps.`] },

{ id: 'q21', level: 'Senior', tags: ['ddd', 'concurrency', 'idempotency', 'commands'],
  q: r`How do you make aggregate commands safe under concurrency and retries: optimistic versions, expected-version commands from clients, idempotent command handling, and retry policies?`,
  a: r`### Optimistic concurrency on the root
A {{rowversion}} (or version number) on the aggregate root; EF adds it to the UPDATE's WHERE clause. Two concurrent commands on the same aggregate: one wins, the other gets a concurrency exception. Because all changes go through the root (and child changes also bump the root's version), the whole aggregate is protected.

### Expected version from clients
For human edits, the client sends the version it saw (ETag / If-Match). A mismatch returns **412** and the UI shows the newer state. Prevents lost updates across think time.

### Automatic retries
For system-initiated commands, catch the conflict, **reload the aggregate and re-execute the command** (the business rule is re-evaluated on fresh state). Bounded retries with jitter. Retrying only the save is wrong.

### Idempotency
Commands can be delivered twice (client retries, message redelivery). Options:
- An **idempotency key** per command stored with a unique constraint in the same transaction (an inbox or processed-commands table).
- Natural idempotency in the domain: {{Reserve(orderId, amount)}} ignores a reservation already present for that order.
- Return the original result for duplicates.

### Child-entity changes and the root version
EF only updates the root row when root columns change. Touch the root's version explicitly (or use a version number incremented by every command) so that concurrent changes to different children still conflict when they share an invariant.`,
  code: r`~~~csharp
public abstract class AggregateRoot<TId>(TId id)
{
    public TId Id { get; protected set; } = id;
    public long Version { get; private set; }
    protected void Touch() => Version++;                      // every command increments, even child-only changes
}

modelBuilder.Entity<Order>().Property(o => o.Version).IsConcurrencyToken();

// Command handler: idempotent + retry the whole command on conflict
public async Task<Result> Handle(AddOrderLine cmd, CancellationToken ct)
{
    for (var attempt = 1; ; attempt++)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        if (await db.ProcessedCommands.AnyAsync(p => p.CommandId == cmd.CommandId, ct)) return Result.AlreadyProcessed();

        var order = await new OrderRepository(db).GetAsync(cmd.OrderId, ct);
        if (order is null) return Result.NotFound();
        if (cmd.ExpectedVersion is { } v && order.Version != v) return Result.PreconditionFailed(order.Version);   // 412 for UI edits

        order.AddLine(cmd.Sku, cmd.Quantity, cmd.UnitPrice);  // rule re-evaluated on fresh state each attempt
        db.ProcessedCommands.Add(new ProcessedCommand(cmd.CommandId));
        try { await db.SaveChangesAsync(ct); return Result.Ok(order.Version); }
        catch (DbUpdateConcurrencyException) when (attempt < 3)
        {
            await Task.Delay(Random.Shared.Next(10, 50) * attempt, ct);
        }
    }
}
~~~`,
  pts: [r`Version on the root protects the whole aggregate.`, r`Expected-version commands give 412 for stale human edits.`, r`System retries reload and re-execute the command, not just the save.`, r`Idempotency keys or natural idempotency handle duplicates.`, r`Bump the root version on child-only changes.`],
  ex: r`Two operators added lines to the same purchase order; each change touched only OrderLines, so the root row (and its rowversion) did not change and both saves succeeded, breaking the order's approval threshold. Incrementing the root version on every command made the second save conflict.`,
  fu: [r`How do you surface a 412 conflict in a good UX?`, r`What retry count is reasonable, and why?`, r`How do idempotency records expire?`],
  pit: [r`Retrying only SaveChanges.`, r`No version bump for child-only changes.`, r`Assuming exactly-once delivery.`] },

{ id: 'q22', level: 'Senior', tags: ['ddd', 'published-language', 'versioning', 'contracts'],
  q: r`Your context publishes integration events consumed by eight other teams. How do you design, version and evolve this published language without breaking consumers?`,
  a: r`### Design
- Events describe **business facts** in the upstream's language ({{PaymentCaptured}}), not CRUD changes ({{PaymentUpdated}}).
- **Minimal but sufficient**: ids, the key facts, timestamps, and enough data to avoid a callback for common consumers. Consider "thin" (ids only, consumers query) vs "fat" (state included) per event; fat events reduce coupling at runtime, thin events reduce schema coupling.
- Envelope: event id, type, version, occurred-at, correlation and causation ids, producer.
- Money as amount + currency; times in UTC; enums as strings.

### Versioning rules
- **Additive changes** only within a version: new optional fields; consumers ignore unknown fields (tolerant reader).
- **Never** rename, remove or change the meaning or type of a field in place.
- Breaking change → new event type or version ({{PaymentCaptured.v2}}), **publish both** during a migration window, track consumers, remove the old one when nobody reads it.
- Schema registry (Avro/Protobuf/JSON Schema) with compatibility checks in CI.

### Governance
- Contracts in a separate package/repo per context, owned by the upstream team.
- **Consumer-driven contract tests** (Pact or schema checks) run in the producer's CI.
- Documentation: an event catalogue (AsyncAPI) with examples and semantics, especially ordering and delivery guarantees (at least once, ordered per key).
- Deprecation policy with dates.`,
  code: r`~~~csharp
namespace Payments.Contracts;

public sealed record EventEnvelope<T>(
    Guid EventId, string Type, int Version, DateTimeOffset OccurredAt,
    Guid CorrelationId, Guid? CausationId, string Producer, T Data);

// v1: published, never changed in place
public sealed record PaymentCapturedV1(Guid PaymentId, Guid MerchantId, decimal Amount, string Currency, DateTimeOffset CapturedAt);

// Additive change within v1 (optional field, tolerant readers ignore it)
// public string? AcquirerReference { get; init; }

// Breaking change: amount split into gross/fee/net -> new version, both published during migration
public sealed record PaymentCapturedV2(Guid PaymentId, Guid MerchantId, MoneyDto Gross, MoneyDto Fee, MoneyDto Net, DateTimeOffset CapturedAt);
public sealed record MoneyDto(decimal Amount, string Currency);

// Publisher emits both versions until consumers migrate
outbox.Add(Envelope(new PaymentCapturedV1(p.Id, p.MerchantId, p.Gross.Amount, p.Gross.Currency, at)));
outbox.Add(Envelope(new PaymentCapturedV2(p.Id, p.MerchantId, p.Gross.ToDto(), p.Fee.ToDto(), p.Net.ToDto(), at)));

// Producer CI: schema compatibility check
// dotnet run --project tools/SchemaCheck -- --registry $REGISTRY --subject payments.captured --mode BACKWARD
~~~`,
  pts: [r`Events are business facts in the upstream's language with a standard envelope.`, r`Only additive changes within a version; tolerant readers.`, r`Breaking changes get a new version published alongside the old one.`, r`Schema registry compatibility checks and consumer-driven contract tests in CI.`, r`Owned contracts package, event catalogue, deprecation dates.`],
  ex: r`A payments team changed Amount from gross to net in place; the finance consumer silently under-reported revenue by 2.3% for a month. The fix introduced a v2 event, a compatibility check in CI, and a consumer registry so producers know who depends on each event.`,
  fu: [r`Thin vs fat events: how do you choose?`, r`How do you find out who still consumes v1?`, r`How do you replay history for a new consumer?`],
  pit: [r`Changing field meaning in place.`, r`CRUD-style "Updated" events.`, r`No compatibility checks in CI.`] },

{ id: 'q23', level: 'Senior', tags: ['ddd', 'cqrs', 'read-models'],
  q: r`How does CQRS fit with DDD? When do you separate the read side from aggregates, how are read models built, and what do you tell a team that wants to load aggregates to serve list screens?`,
  a: r`### The fit
Aggregates are optimised for **enforcing invariants on writes**: small, encapsulated, loaded by id. Screens need **joins across aggregates**, filters, sorting, paging and aggregates of data. Bending aggregates to serve screens (exposing collections, adding navigation everywhere, loading many aggregates) destroys their purpose.

### Levels of CQRS
1. **Same database, separate code paths**: commands use repositories and aggregates; queries use projections straight from the DbContext or SQL views ({{AsNoTracking}}, DTOs). Cheap, usually enough.
2. **Separate read tables** updated in the same transaction or by handlers after commit (denormalised for screens).
3. **Separate read store** (Elasticsearch, Redis, another database) fed by events, eventually consistent, scaled independently.

### Read models
- Built per **use case** (a merchant dashboard, a statement screen), not as a generic copy of the domain.
- Updated by **projections** consuming domain/integration events, idempotently, with a checkpoint.
- Rebuildable from events or source tables.

### Consistency UX
With async projections, the user may not see their own change immediately: return the new state from the command, use the version to wait briefly, or show "processing".

### Answer to the team
Do not load aggregates for lists: use query objects with projections (level 1). Introduce separate read stores only when query load, shape or scale requires it.`,
  code: r`~~~csharp
// Write side: aggregate via repository
public async Task Handle(ApproveInvoice cmd, CancellationToken ct)
{
    var invoice = await invoices.GetAsync(cmd.InvoiceId, ct) ?? throw new NotFoundException();
    invoice.Approve(cmd.ApprovedBy);
    await uow.SaveChangesAsync(ct);
}

// Read side, level 1: projection query, no aggregates
public sealed class SupplierInvoicesQuery(InvoicingDbContext db)
{
    public Task<List<InvoiceRow>> RunAsync(SupplierId s, int page, CancellationToken ct) =>
        db.Invoices.AsNoTracking().Where(i => i.SupplierId == s)
          .OrderByDescending(i => i.ReceivedOn).Skip(page * 50).Take(50)
          .Select(i => new InvoiceRow(i.Id.Value, i.Number, i.Total.Amount, i.Total.Currency, i.Status.ToString()))
          .ToListAsync(ct);
}

// Read side, level 3: projection from events into a denormalised store
public sealed class MerchantDashboardProjection(ReadDb read) : IEventHandler<PaymentCapturedV1>
{
    public async Task Handle(EventEnvelope<PaymentCapturedV1> e, CancellationToken ct)
    {
        if (await read.Checkpoints.AnyAsync(c => c.EventId == e.EventId, ct)) return;      // idempotent
        await read.Database.ExecuteSqlAsync($"""
            UPDATE dash.MerchantDaily SET Captured = Captured + {e.Data.Amount}, Count = Count + 1
            WHERE MerchantId = {e.Data.MerchantId} AND Day = {DateOnly.FromDateTime(e.Data.CapturedAt.UtcDateTime)}
            """, ct);
        read.Checkpoints.Add(new Checkpoint(e.EventId));
        await read.SaveChangesAsync(ct);
    }
}
~~~`,
  pts: [r`Aggregates serve writes and invariants; screens need projections.`, r`Start with separate query code on the same database.`, r`Separate read stores fed by events only when needed.`, r`Read models per use case, idempotent and rebuildable.`, r`Handle read-your-writes UX with versions or returned state.`],
  ex: r`An invoicing service loaded 5,000 Invoice aggregates with all lines to render a supplier list, taking 9 seconds. A projection query returning 50 rows took 30 ms; the aggregates shrank back to their invariant-protecting role.`,
  fu: [r`How do you rebuild a read model from scratch?`, r`How do you handle a projection that falls behind?`, r`When does a separate read database pay for itself?`],
  pit: [r`Loading aggregates for list screens.`, r`Generic read models mirroring the domain.`, r`Non-idempotent projections.`] },

{ id: 'q24', level: 'Senior', tags: ['ddd', 'event-sourcing', 'aggregates'],
  q: r`When would you event-source an aggregate in a DDD system? Show how an event-sourced aggregate works (apply, decide, rehydrate, snapshots) and list the costs.`,
  a: r`### Event-sourced aggregate
State is not stored; the **stream of domain events** is. To handle a command: load the stream, **rehydrate** state by applying events, **decide** (validate, produce new events), **append** new events with an **expected version** (optimistic concurrency at the stream level).

### When it pays off
- **History is the business**: ledgers, trading positions, insurance policies with endorsements, case management.
- **Audit and regulatory reconstruction**: "what did we know, when?".
- Many projections needed from the same facts.
- Temporal queries and debugging by replay.

### When it does not
- CRUD-heavy domains, simple lifecycles.
- Teams new to it on a deadline.
- Requirements to delete data (GDPR) without a crypto-shredding plan.

### Costs
- **Event schema versioning** forever (upcasters for old events).
- **Projections** for every query; eventual consistency on reads.
- Rehydration time for long streams: **snapshots** every N events, or close the books (period-end streams).
- Tooling and operations: event store (EventStoreDB, Marten on PostgreSQL), replays, projection rebuilds.
- Mental model shift for the team.

### Design tips
Separate **decide** (pure: state + command → events) from **evolve** (state + event → state). Pure functions make testing trivial: given events, when command, then events.`,
  code: r`~~~csharp
public sealed class Position                               // event-sourced aggregate: trading position per book and instrument
{
    public decimal Quantity { get; private set; }
    public decimal AvgPrice { get; private set; }
    public long Version { get; private set; } = -1;

    // evolve: state + event -> state (no validation, events are facts)
    public void Apply(object e)
    {
        switch (e)
        {
            case TradeBooked t:
                var newQty = Quantity + t.Quantity;
                AvgPrice = newQty == 0 ? 0 : (AvgPrice * Quantity + t.Price * t.Quantity) / newQty;
                Quantity = newQty; break;
            case TradeCancelled c:
                Quantity -= c.Quantity; break;
        }
        Version++;
    }

    // decide: state + command -> events
    public IEnumerable<object> Decide(BookTrade cmd, decimal limit)
    {
        if (Math.Abs(Quantity + cmd.Quantity) > limit) throw new DomainException("Position limit exceeded");
        yield return new TradeBooked(cmd.TradeId, cmd.Quantity, cmd.Price, cmd.At);
    }

    public static Position Rehydrate(IEnumerable<object> history, PositionSnapshot? snapshot = null)
    {
        var p = snapshot?.ToPosition() ?? new Position();
        foreach (var e in history) p.Apply(e);
        return p;
    }
}

// Handler with stream-level optimistic concurrency (Marten-style)
var stream = await session.Events.FetchStreamAsync(positionId, token: ct);
var position = Position.Rehydrate(stream.Select(e => e.Data));
var newEvents = position.Decide(cmd, limits.For(cmd.Book)).ToArray();
session.Events.Append(positionId, stream.Count + newEvents.Length, newEvents);   // expected version after append
await session.SaveChangesAsync(ct);                        // fails if someone else appended meanwhile
~~~`,
  pts: [r`Store events, rehydrate state, decide new events, append with an expected version.`, r`Fits domains where history is the business or must be reconstructed.`, r`Costs: event versioning forever, projections, snapshots, tooling, team learning.`, r`Separate pure decide and evolve functions for testability.`, r`Plan GDPR with crypto-shredding before choosing it.`],
  ex: r`A trading firm event-sourced positions; when a regulator asked for the position at 14:32 on a past date including later-cancelled trades, the team replayed the stream to that point in minutes. The same firm deliberately kept its client-onboarding context state-based because its history had no business value.`,
  fu: [r`How do you version an event whose meaning changed?`, r`When do you take snapshots?`, r`How do you delete personal data from an event store?`],
  pit: [r`Event sourcing everything.`, r`Validation inside Apply.`, r`No plan for event schema evolution.`] },

{ id: 'q25', level: 'Senior', tags: ['ddd', 'saga', 'bounded-contexts', 'long-running'],
  q: r`A cross-border payment spans Payments, FX, Compliance and Ledger contexts and can take hours. Design the saga across bounded contexts: orchestration vs choreography, compensations, timeouts, and where the saga's state lives.`,
  a: r`### Shape of the process
1. Payments accepts the instruction.
2. Compliance screens (sanctions, AML): may take hours with manual review.
3. FX books a conversion at a quoted rate (quote expires).
4. Ledger posts debit, FX legs and credit.
5. Payments sends to the scheme; confirmation or return arrives later.

### Orchestration
A **payment saga (process manager) in the Payments context** owns the process state, sends commands to other contexts, listens to their events, handles timeouts and compensations. Preferred here: many steps, conditional paths, manual review, and a clear owner for "where is my payment?".

### Choreography
Each context reacts to the previous event. Fine for 2 to 3 steps; with five contexts and branches, the process becomes invisible and hard to change.

### Compensations
Semantic, not technical:
- FX booked but compliance later rejects → **reverse the FX deal** (possibly at a loss: a business decision).
- Ledger posted but the scheme returns the payment → **post a reversal** and refund.
Some steps are **pivot points** (sending to the scheme) after which you can only go forward or issue a new reverse payment.

### Timeouts and waiting
Durable timers: quote expiry (re-quote), manual-review SLA escalation, scheme confirmation timeout (investigate).

### State and reliability
Saga state in the Payments database, updated with the outbox in the same transaction; all steps idempotent with the payment id as the key; full audit trail of transitions for operations and regulators.`,
  dia: r`sequenceDiagram
  participant S as Payment saga
  participant C as Compliance
  participant F as FX
  participant L as Ledger
  participant N as Scheme
  S->>C: ScreenPayment
  C-->>S: PaymentCleared
  S->>F: BookConversion with quote id
  F-->>S: ConversionBooked
  S->>L: PostPayment
  L-->>S: PaymentPosted
  S->>N: SendToScheme - pivot point
  N-->>S: PaymentReturned
  S->>L: PostReversal
  S->>F: ReverseConversion`,
  code: r`~~~csharp
public sealed class CrossBorderPaymentSaga : AggregateRoot<PaymentId>
{
    public SagaStep Step { get; private set; }
    public Guid? FxDealId { get; private set; }
    public DateTimeOffset? QuoteExpiresAt { get; private set; }

    public IEnumerable<ICommand> On(PaymentCleared e, Quote quote)
    {
        if (Step != SagaStep.Screening) yield break;
        Step = SagaStep.BookingFx; QuoteExpiresAt = quote.ExpiresAt;
        yield return new BookConversion(Id, quote.Id, e.Amount, e.TargetCurrency);
    }

    public IEnumerable<ICommand> On(ConversionBooked e)
    {
        if (Step != SagaStep.BookingFx) yield break;
        FxDealId = e.DealId; Step = SagaStep.Posting;
        yield return new PostPayment(Id, e.SourceAmount, e.TargetAmount, e.DealId);
    }

    public IEnumerable<ICommand> On(PaymentRejectedByCompliance e)
    {
        Step = SagaStep.Compensating;
        if (FxDealId is { } deal) yield return new ReverseConversion(deal);       // semantic compensation
        yield return new NotifyCustomer(Id, NotificationKind.PaymentRejected);
    }

    public IEnumerable<ICommand> OnTimer(DateTimeOffset now)
    {
        if (Step == SagaStep.BookingFx && now > QuoteExpiresAt) yield return new RequestNewQuote(Id);
    }
}
~~~`,
  pts: [r`Orchestrate long, branching cross-context processes from the owning context.`, r`Choreography only for short flows.`, r`Compensations are business actions; pivot points allow only forward recovery.`, r`Durable timers for quotes, review SLAs and confirmations.`, r`Saga state with outbox in one transaction; idempotent steps; full audit trail.`],
  ex: r`A remittance company's choreographed flow across five services made "where is my payment?" calls take operations an average of 25 minutes to answer. An orchestrating saga with a visible state per payment cut that to seconds and exposed that 3% of payments waited on expired FX quotes, fixed with automatic re-quoting.`,
  fu: [r`Who absorbs the FX loss when a deal must be reversed?`, r`How do you migrate in-flight sagas when the process changes?`, r`What does the operations UI need from the saga?`],
  pit: [r`Choreography for long multi-context processes.`, r`Technical rollbacks instead of business compensations.`, r`Ignoring pivot points.`] },

{ id: 'q26', level: 'Senior', tags: ['ddd', 'modular-monolith', 'boundaries', 'architecture-tests'],
  q: r`You decide to implement four bounded contexts as a modular monolith rather than microservices. How do you enforce the context boundaries inside one deployable so it does not decay into a big ball of mud?`,
  a: r`### Why a modular monolith
Same boundaries as microservices without distributed-systems costs (network failures, distributed transactions, deployment orchestration). A good starting point when the team is small or boundaries are still being discovered; extracting a module later is straightforward if boundaries were kept.

### Boundary rules
1. **Separate projects per module** (Api, Application, Domain, Infrastructure, Contracts); only the **Contracts** project is visible to other modules.
2. **No cross-module domain references**: other modules use a module's public API (in-process interfaces or mediator requests) or its integration events.
3. **Own data**: separate schema and DbContext per module; no joins across schemas; no shared tables.
4. **Integration**: in-process events through an outbox (same as microservices) or synchronous calls through public facades; never calling another module's repositories.
5. **Internal by default**: types are {{internal}}; {{InternalsVisibleTo}} only for tests.

### Enforcement
- **Architecture tests** (NetArchTest, ArchUnitNET) in CI: "Billing.Domain must not depend on Sales.*", "no module references another module's Infrastructure".
- Database permissions per module schema (each DbContext uses a login that only sees its schema), so cross-schema SQL fails.
- Code owners per module folder.

### Extraction later
Because modules talk via contracts and events and own their schemas, extracting one into a service means: move the project, switch in-process calls to HTTP/messaging, point the outbox at a broker, move the schema.`,
  dia: r`flowchart TB
  subgraph Host[Single deployable]
    A[Sales module] -->|Contracts only| B[Billing module]
    B -->|Integration events via in-process outbox| C[Ledger module]
    D[Support module] -->|Contracts only| A
  end
  A --- SA[(sales schema)]
  B --- SB[(billing schema)]
  C --- SC[(ledger schema)]
  D --- SD[(support schema)]`,
  code: r`~~~csharp
// Module registration: each module wires its own services, DbContext and schema
public static class BillingModule
{
    public static IServiceCollection AddBillingModule(this IServiceCollection s, IConfiguration cfg)
    {
        s.AddDbContext<BillingDbContext>(o => o.UseSqlServer(cfg.GetConnectionString("Billing"),   // login limited to schema 'billing'
            sql => sql.MigrationsHistoryTable("__EFMigrationsHistory", "billing")));
        s.AddScoped<IBillingApi, BillingApi>();                                                   // public facade (Contracts)
        return s;
    }
}

// Architecture tests in CI
[Fact]
public void Billing_domain_does_not_depend_on_other_modules()
{
    var result = Types.InAssembly(typeof(Billing.Domain.Invoice).Assembly)
        .ShouldNot().HaveDependencyOnAny("Sales", "Ledger", "Support")
        .GetResult();
    Assert.True(result.IsSuccessful, string.Join(", ", result.FailingTypeNames ?? []));
}

[Fact]
public void Modules_only_reference_other_modules_contracts()
{
    var result = Types.InAssembly(typeof(Sales.Application.Marker).Assembly)
        .ShouldNot().HaveDependencyOnAny("Billing.Domain", "Billing.Application", "Billing.Infrastructure")
        .GetResult();
    Assert.True(result.IsSuccessful);
}
~~~`,
  pts: [r`Modular monolith keeps context boundaries without distributed costs.`, r`Only Contracts are public; everything else internal.`, r`Schema and DbContext per module; no cross-schema joins.`, r`Architecture tests and per-schema database logins enforce boundaries.`, r`Well-kept modules extract cleanly into services later.`],
  ex: r`A fintech started with six services for six engineers and spent most of its time on deployment and distributed bugs. Consolidating into a modular monolith with architecture tests doubled feature throughput; two years later one module (payments) was extracted for scaling in three weeks.`,
  fu: [r`How do you handle a report that needs data from three modules?`, r`When should a module be extracted into a service?`, r`How do you prevent shared "Common" projects from becoming a dumping ground?`],
  pit: [r`Shared DbContext across modules.`, r`Public domain types used across modules.`, r`No automated boundary checks.`] },

{ id: 'q27', level: 'Senior', tags: ['ddd', 'data-ownership', 'replication', 'integration'],
  q: r`Context B needs data owned by context A (customer names for invoices, product prices for orders). Compare synchronous API calls, event-carried state transfer into local copies, and shared databases, and decide for each case.`,
  a: r`### Options
| Option | Pros | Cons |
|---|---|---|
| **Synchronous query to A** at use time | always fresh, no copy | runtime coupling: A's latency and availability become B's; chatty calls |
| **Event-carried state transfer**: B keeps a local copy updated from A's events | B works when A is down; fast local queries; B shapes the data it needs | eventual consistency; storage; must handle ordering and rebuilds |
| **Shared database / tables** | easy at first | schema coupling, no ownership, impossible to evolve; avoid |

### Decision questions
1. **Does B need the value as of a moment** (price at order time, name on an invoice when issued)? Then **copy it into B's own aggregate at that moment**: it is B's fact now (an order line stores the price it was sold at).
2. **Does B need current data for display?** A local read-model copy updated from events, or a query to A, depending on availability needs.
3. **Is it a decision that A must make authoritatively** (credit check, stock reservation)? Ask A synchronously at the decision point (or via a saga).

### Event-carried state transfer details
- Store only the fields B needs, with A's version or timestamp; ignore older updates.
- Rebuild by replaying A's events or a snapshot export.
- Never treat the copy as authoritative for A's invariants.

### Shared reference data
Instruments, currencies, calendars: an upstream reference-data context publishing changes; consumers cache them, often conformist.`,
  code: r`~~~csharp
// 1. Value as of a moment: copied into B's aggregate (order line keeps sale price)
order.AddLine(sku, qty, unitPrice: await pricing.CurrentPriceAsync(sku, ct));   // stored on the line forever

// 2. Local copy updated from A's events (event-carried state transfer) with versioning
public sealed class CustomerReplica(BillingDbContext db) : IEventHandler<CustomerProfileChangedV1>
{
    public async Task Handle(EventEnvelope<CustomerProfileChangedV1> e, CancellationToken ct)
    {
        var copy = await db.CustomerCopies.FindAsync([e.Data.CustomerId], ct);
        if (copy is null) db.CustomerCopies.Add(copy = new CustomerCopy(e.Data.CustomerId));
        if (e.Data.Version <= copy.SourceVersion) return;                  // ignore stale or duplicate updates
        copy.Update(e.Data.LegalName, e.Data.BillingAddress, e.Data.Version);
        await db.SaveChangesAsync(ct);
    }
}

// 3. Authoritative decision: ask the owner at decision time
var reservation = await inventoryApi.ReserveAsync(new ReserveRequest(order.Id.Value, order.Lines.ToDto()), ct);
if (!reservation.Succeeded) order.Reject(RejectionReason.OutOfStock);
~~~`,
  pts: [r`Snapshot values belong in B's aggregate at the moment of the fact.`, r`Local copies via events give autonomy at the cost of eventual consistency.`, r`Authoritative decisions are made by the owner, synchronously or via a saga.`, r`Version local copies and ignore stale updates.`, r`Never share databases across contexts.`],
  ex: r`An invoicing context read customer names live from the CRM API; a CRM outage stopped month-end invoicing for six hours, and re-printed invoices showed customers' new names instead of the names at issue time. Copying the name into the invoice at issue and replicating profiles via events fixed both problems.`,
  fu: [r`How do you backfill a new local copy?`, r`How stale can a local copy be before it is a problem?`, r`What about GDPR erasure across replicated copies?`],
  pit: [r`Live lookups for historical documents.`, r`Shared tables between contexts.`, r`Treating replicas as authoritative.`] },

{ id: 'q28', level: 'Senior', tags: ['ddd', 'persistence-ignorance', 'pragmatism', 'ef-core'],
  q: r`How pure should the domain model be? Discuss persistence ignorance, EF Core compromises (private constructors, backing fields, navigation choices), and when a separate persistence model is worth the mapping cost.`,
  a: r`### Persistence ignorance
The domain should express business rules without depending on how it is stored: no {{DbContext}}, no EF attributes, no SQL. Benefits: testability, clarity, and freedom to change storage.

### Acceptable compromises with EF Core
- Private parameterless constructors for materialisation.
- Backing fields and private setters (EF maps them).
- An id property on child entities that EF needs.
- A {{Version}} property for concurrency.
These cost little and keep one model.

### Compromises to refuse
- Data annotations in domain classes (configure in infrastructure).
- Navigation properties between aggregates "because EF likes them".
- Public setters for the ORM.
- Lazy-loading proxies (virtual everything, hidden I/O).

### Separate persistence model
Domain objects ↔ mapping ↔ persistence records. Worth it when:
- The storage shape differs radically from the model (legacy schema you cannot change, document store, event store).
- The domain model must be completely free of ORM constraints (complex value object graphs EF cannot map).
Costs: mapping code for every change, tracking changes yourself (or full replace), more bugs at the boundary.

### My default
One model mapped with EF Core using the acceptable compromises; a separate persistence model only for legacy schemas or event-sourced aggregates.`,
  code: r`~~~csharp
// Domain: no EF types, no attributes; only small concessions (private ctor, private setters)
public sealed class Policy : AggregateRoot<PolicyId>
{
    private readonly List<Endorsement> _endorsements = [];
    public PolicyNumber Number { get; private set; }
    public DateRange Cover { get; private set; }
    public IReadOnlyList<Endorsement> Endorsements => _endorsements;
    private Policy() { Number = default!; Cover = default!; }       // concession for EF materialisation
    public void Endorse(Endorsement e) { /* rules */ _endorsements.Add(e); Touch(); }
}

// Infrastructure: all mapping here
internal sealed class PolicyConfiguration : IEntityTypeConfiguration<Policy>
{
    public void Configure(EntityTypeBuilder<Policy> b)
    {
        b.Property(p => p.Number).HasConversion(n => n.Value, v => new PolicyNumber(v)).HasMaxLength(20);
        b.ComplexProperty(p => p.Cover, c => { c.Property(x => x.From).HasColumnName("CoverFrom"); c.Property(x => x.To).HasColumnName("CoverTo"); });
        b.OwnsMany(p => p.Endorsements, e => e.ToTable("Endorsements"));
        b.Navigation(p => p.Endorsements).UsePropertyAccessMode(PropertyAccessMode.Field);
    }
}

// Separate persistence model for a legacy schema you cannot change
internal sealed class LegacyPolicyRepository(LegacyDb db) : IPolicyRepository
{
    public async Task<Policy?> GetAsync(PolicyId id, CancellationToken ct)
    {
        var row = await db.POL_MASTER.SingleOrDefaultAsync(r => r.POL_ID == id.Value, ct);
        var ends = await db.POL_END.Where(r => r.POL_ID == id.Value).ToListAsync(ct);
        return row is null ? null : PolicyMapper.ToDomain(row, ends);                  // explicit mapping both ways
    }
}
~~~`,
  pts: [r`Domain free of DbContext, attributes and SQL.`, r`Small concessions are fine: private constructors, backing fields, private setters.`, r`Refuse public setters, cross-aggregate navigations and lazy proxies.`, r`Separate persistence models for legacy schemas or event stores.`, r`Mapping layers cost real effort: use them only when the shapes truly differ.`],
  ex: r`A team insisted on a fully separate persistence model for every aggregate; 40% of their changes touched mapping code and three production bugs came from fields mapped one way but not the other. Collapsing to EF mappings with private setters removed the mapping layer except for one legacy policy schema.`,
  fu: [r`How do you test mappings?`, r`What breaks when EF can not map a value object graph?`, r`How do you handle optimistic concurrency with a separate persistence model?`],
  pit: [r`Purity at any cost.`, r`ORM convenience leaking public setters into the domain.`, r`Lazy loading in domain objects.`] },

{ id: 'q29', level: 'Senior', tags: ['ddd', 'rules-engine', 'configuration', 'policies'],
  q: r`The business wants to change fee schedules, eligibility rules and limits without deployments. When do you keep rules in code, move them to configuration or tables, or adopt a rules engine, and how do you keep the domain model coherent?`,
  a: r`### Categories of rules
| Kind | Example | Where |
|---|---|---|
| **Structural invariants** | refund ≤ captured, balanced journal | **code** (aggregate), tested, rarely change |
| **Parameters** | fee rate 1.4%, limit 5,000, grace days 5 | **configuration / reference tables**, versioned and effective-dated |
| **Rule tables** | fee by tier × method × region | **decision tables** in the database, edited through a governed UI |
| **Complex, frequently changing logic owned by business analysts** | underwriting scorecards, eligibility | **rules engine** or a DSL (DMN, Microsoft RulesEngine), with tests |

### Keep the domain coherent
- The aggregate still owns **when** a rule is applied and the **invariants**; it asks a **policy** port ({{IFeePolicy}}) for parameterised decisions.
- Policies are **versioned and effective-dated**: record which version produced each decision (audit, disputes, recalculation).
- Validate configuration changes like code: schema validation, test cases that must pass, four-eyes approval, staged rollout.

### Risks of "no-deploy" rules
- Untested changes in production; rules no one understands; performance surprises in engines.
- Logic split between code and engine with no single view.
Mitigate with a test harness business users can run, change history, and monitoring of decision distributions after changes.`,
  code: r`~~~csharp
// Policy port used by the aggregate; parameters come from versioned, effective-dated tables
public interface IFeePolicy
{
    FeeDecision Decide(MerchantTier tier, PaymentMethod method, Money amount, DateOnly on);
}
public sealed record FeeDecision(Money Fee, string ScheduleVersion);

internal sealed class TableFeePolicy(FeeScheduleCache cache) : IFeePolicy
{
    public FeeDecision Decide(MerchantTier tier, PaymentMethod method, Money amount, DateOnly on)
    {
        var schedule = cache.EffectiveOn(on);                                   // versioned, approved schedule
        var row = schedule.Rows.Single(r => r.Tier == tier && r.Method == method && r.Currency == amount.Currency);
        var fee = Money.Max(amount.Multiply(row.Rate), row.MinimumFee);
        return new FeeDecision(fee, schedule.Version);
    }
}

// Aggregate records which rule version produced the decision
public void Capture(Money amount, IFeePolicy fees, DateOnly on)
{
    /* invariants in code */
    var decision = fees.Decide(MerchantTier, Method, amount, on);
    Fee = decision.Fee;
    FeeScheduleVersion = decision.ScheduleVersion;                               // audit and disputes
    Raise(new PaymentCaptured(Id, amount, decision.Fee, decision.ScheduleVersion));
}

// Approval gate for a new schedule: golden cases must pass before activation
[Fact] public void Schedule_2026_11_passes_golden_cases() => GoldenCases.AssertAll(FeeSchedules.Load("2026-11"));
~~~`,
  pts: [r`Invariants in code; parameters in versioned tables; complex analyst-owned logic in engines.`, r`Aggregates call policy ports and own when rules apply.`, r`Version and effective-date rules; record the version used per decision.`, r`Govern rule changes like code: tests, approvals, staged rollout.`, r`Watch decision distributions after changes.`],
  ex: r`A lender let analysts edit eligibility rules in a rules engine without tests; a missing parenthesis approved applicants with no income for four hours. Afterwards every rule change had to pass 200 golden cases and was rolled out to 5% of traffic first.`,
  fu: [r`How do you recalculate past fees after a schedule error?`, r`How do you test rules owned by analysts?`, r`When does a rules engine become a liability?`],
  pit: [r`Invariants moved into configuration.`, r`Unversioned rule changes.`, r`No record of which rule produced a decision.`] },

{ id: 'q30', level: 'Senior', tags: ['ddd', 'legacy', 'strangler-fig', 'migration'],
  q: r`Carve a bounded context (say, Fees) out of a 15-year-old monolith whose database every module reads. Walk through the strangler approach with DDD: finding the seam, anti-corruption layers both ways, data migration and cut-over.`,
  a: r`### 1. Choose the context
High business value, reasonably clear language, a team ready to own it, and pain in the current implementation (fee bugs, slow changes).

### 2. Find the seams
- Who calls fee logic (entry points)? Who reads fee tables directly (reports, batch jobs)?
- Build a dependency inventory: code callers, SQL readers, file exports.

### 3. Build the new context beside the monolith
- New model in the ubiquitous language, own schema/database.
- **ACL from new to old** for data it still needs from the monolith (accounts, merchants).
- **ACL from old to new**: the monolith's fee entry points call the new context through an adapter (branch by abstraction), behind a feature flag.

### 4. Parallel run
Run old and new side by side ("shadow mode"): the new one computes fees for real traffic, results are compared, differences investigated. Business sign-off on discrepancies.

### 5. Data
- Migrate historical fee data or leave it in the monolith with read access through an ACL.
- During transition, publish changes from the new context back to the old tables (or a view) for **direct-SQL readers** until they migrate.

### 6. Cut-over and cleanup
Flip the flag per merchant segment; monitor; remove old code and tables after readers have moved. Track remaining direct readers as debt with owners and dates.`,
  dia: r`flowchart LR
  M[Monolith callers] --> F{Feature flag}
  F -->|old path| OLD[Legacy fee code]
  F -->|new path| ACL1[Adapter: monolith to Fees API]
  ACL1 --> NEW[Fees context]
  NEW --> ACL2[ACL: reads merchants and accounts from monolith]
  NEW -->|sync back during transition| OLDT[(Legacy fee tables for SQL readers)]
  NEW -.->|shadow comparison| CMP[Diff reports]
  OLD -.-> CMP`,
  code: r`~~~csharp
// Branch by abstraction inside the monolith
public interface IFeeCalculator { Money Calculate(Transaction t); }

public sealed class FeeCalculatorRouter(LegacyFeeCalculator legacy, FeesContextClient fees, IFeatureFlags flags,
                                        IShadowComparer shadow) : IFeeCalculator
{
    public Money Calculate(Transaction t)
    {
        var mode = flags.Variant("fees-context", t.MerchantSegment);              // off | shadow | on
        var old = mode != "on" ? legacy.Calculate(t) : default;
        if (mode == "off") return old;
        var @new = fees.CalculateAsync(t.ToFeeRequest()).GetAwaiter().GetResult();  // legacy sync boundary, isolated here
        if (mode == "shadow") { shadow.Record(t.Id, old, @new); return old; }      // compare, still use old
        return @new;
    }
}

// Shadow comparison report: discrepancies by reason, reviewed with the business
// SELECT Reason, COUNT(*), SUM(ABS(NewFee - OldFee)) FROM fees_shadow.Diffs WHERE Day = @d GROUP BY Reason;
~~~`,
  pts: [r`Pick a valuable context with clear language and an owning team.`, r`Inventory seams: code callers and direct SQL readers.`, r`ACLs in both directions; branch by abstraction behind flags.`, r`Shadow mode compares old and new on real traffic before cut-over.`, r`Sync back for legacy readers temporarily; remove them with owners and dates.`],
  ex: r`A bank extracted fee calculation from a mainframe-fronted monolith; shadow mode ran for six weeks and found 14 discrepancy categories, three of which were long-standing bugs in the old system that finance chose to keep for existing contracts. Cut-over by segment completed with zero billing incidents.`,
  fu: [r`How do you handle reports that join fee tables with other monolith tables?`, r`How long should shadow mode run?`, r`What if the old behaviour is wrong but contractual?`],
  pit: [r`Big-bang replacement.`, r`Ignoring direct SQL readers.`, r`Copying the legacy model into the new context.`] },

{ id: 'q31', level: 'Senior', tags: ['ddd', 'idempotency', 'inbox', 'ordering'],
  q: r`Consumers of integration events receive duplicates and out-of-order messages. Design idempotent, order-aware event handling in a bounded context (inbox pattern, versions, per-aggregate ordering).`,
  a: r`### Facts of life
At-least-once delivery means **duplicates**; retries, partitions and multiple producers mean **reordering** unless you design for it.

### Idempotency
- **Inbox table**: store each processed event id in the **same transaction** as the state change; skip if already present. Expire entries after the maximum redelivery window.
- **Natural idempotency**: operations that are no-ops when repeated (set status to Shipped; add a reservation keyed by order id).

### Ordering
- Producers key messages by **aggregate id** so a broker partition preserves per-aggregate order (Kafka).
- Events carry the **aggregate version** (or a sequence number). The consumer stores the last applied version per source aggregate and:
  - ignores events with version ≤ last applied (duplicates or stale);
  - for a gap (version > last + 1), parks the event and waits, or fetches current state from the producer, depending on the use case.
- For "last write wins" replicas, apply only if newer; for "every event matters" (ledger postings), require contiguity.

### Poison events
Retry with backoff, then dead-letter with the reason; for per-aggregate ordering, decide whether later events for that aggregate wait (consistency) or continue (availability).

### Where this lives
Infrastructure wrappers around handlers (a decorator or middleware), so domain handlers stay clean.`,
  code: r`~~~csharp
// Idempotent + order-aware handler decorator
public sealed class InboxHandler<T>(IEventHandler<T> inner, InboxDbContext db) : IEventHandler<T> where T : IVersionedEvent
{
    public async Task Handle(EventEnvelope<T> e, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (await db.Inbox.AnyAsync(i => i.EventId == e.EventId, ct)) return;                         // duplicate

        var cursor = await db.Cursors.FindAsync([e.Data.AggregateId], ct) ?? db.Cursors.Add(new Cursor(e.Data.AggregateId, 0)).Entity;
        if (e.Data.AggregateVersion <= cursor.LastVersion) { await RecordAsync(e, ct); return; }      // stale
        if (e.Data.AggregateVersion > cursor.LastVersion + 1) throw new OutOfOrderException(e.Data.AggregateId, cursor.LastVersion, e.Data.AggregateVersion);  // retry later

        await inner.Handle(e, ct);                                                                    // same DbContext/transaction
        cursor.LastVersion = e.Data.AggregateVersion;
        await RecordAsync(e, ct);
        await tx.CommitAsync(ct);
    }

    private async Task RecordAsync(EventEnvelope<T> e, CancellationToken ct)
    {
        db.Inbox.Add(new InboxEntry(e.EventId, DateTimeOffset.UtcNow));
        await db.SaveChangesAsync(ct);
    }
}
~~~`,
  pts: [r`Assume duplicates and reordering.`, r`Inbox table in the same transaction, or natural idempotency.`, r`Key by aggregate id; carry aggregate versions; track the last applied version.`, r`Stale events ignored; gaps parked or resolved by fetching state.`, r`Poison handling with dead-letters; keep this in infrastructure decorators.`],
  ex: r`A loyalty context applied PointsEarned events twice during a broker failover and credited 1.3 million extra points worth about 90,000 GBP. An inbox table and per-account version cursor made reprocessing harmless; the overcredit was reversed using the event history.`,
  fu: [r`How long do you keep inbox entries?`, r`What do you do with a gap that never fills?`, r`How does this differ for last-write-wins replicas vs ledgers?`],
  pit: [r`Assuming exactly-once delivery.`, r`Inbox written in a separate transaction.`, r`Applying stale events over newer state.`] },

{ id: 'q32', level: 'Senior', tags: ['ddd', 'error-handling', 'result-pattern', 'problem-details'],
  q: r`How should a DDD codebase represent domain errors: exceptions vs Result types, error taxonomy, and mapping to HTTP (ProblemDetails) and to message handling?`,
  a: r`### Taxonomy
| Kind | Example | Representation | HTTP |
|---|---|---|---|
| Invalid input | malformed IBAN | validation result at the edge | 400 |
| Business rule outcome (expected) | insufficient funds, limit exceeded, invalid transition | Result failure or specific domain exception | 409 / 422 |
| Not found / forbidden | | application layer result | 404 / 403 |
| Concurrency conflict | stale version | exception from persistence | 409 / 412 |
| Programming error / invariant broken by a bug | null where impossible | exception | 500 |
| Infrastructure failure | timeout, broker down | exception, retried | 503 |

### Exceptions vs Result
- **Result types** make expected outcomes explicit in signatures, compose well, and avoid exception cost for frequent business rejections (card declines at high volume).
- **Domain exceptions** keep aggregate code simple and are fine when rejections are rare.
- Pick **one convention** for business outcomes; never use exceptions for normal control flow in hot paths, and never return results for bugs.

### Error codes
Stable, documented codes ({{payment.capture.exceeds_authorisation}}) independent of messages: clients and support depend on them.

### Mapping
- HTTP: ProblemDetails with {{type}}, {{title}}, {{status}}, code and details; one exception/result-to-ProblemDetails mapper.
- Messaging: business rejections are **outcomes** (publish a rejected event), not retries; infrastructure failures are retried; bugs go to dead-letter.`,
  code: r`~~~csharp
public sealed record DomainError(string Code, string Message, ErrorKind Kind);
public enum ErrorKind { Validation, Rule, NotFound, Conflict }

public sealed class CardPayment
{
    public Result Capture(Money amount)
    {
        if (Status is not (PaymentStatus.Authorised or PaymentStatus.PartiallyCaptured))
            return Result.Fail(new DomainError("payment.capture.invalid_state", $"Cannot capture a {Status} payment", ErrorKind.Rule));
        if (Captured.Add(amount) > Authorised)
            return Result.Fail(new DomainError("payment.capture.exceeds_authorisation", "Capture exceeds authorised amount", ErrorKind.Rule));
        /* apply */ return Result.Ok();
    }
}

// One mapping point to ProblemDetails
public static IResult ToHttp(this Result r) => r.IsSuccess ? Results.NoContent() : r.Error!.Kind switch
{
    ErrorKind.Validation => Results.Problem(statusCode: 400, title: r.Error.Message, extensions: new Dictionary<string, object?> { ["code"] = r.Error.Code }),
    ErrorKind.NotFound   => Results.Problem(statusCode: 404, title: r.Error.Message, extensions: new Dictionary<string, object?> { ["code"] = r.Error.Code }),
    ErrorKind.Conflict   => Results.Problem(statusCode: 409, title: r.Error.Message, extensions: new Dictionary<string, object?> { ["code"] = r.Error.Code }),
    _                    => Results.Problem(statusCode: 422, title: r.Error.Message, extensions: new Dictionary<string, object?> { ["code"] = r.Error.Code }),
};

// Message handler: business rejection is an outcome, not a retry
var result = payment.Capture(cmd.Amount);
if (result.IsFailure) { outbox.Add(new CaptureRejected(cmd.PaymentId, result.Error!.Code)); await uow.SaveChangesAsync(ct); return; }
~~~`,
  pts: [r`Classify errors: input, business outcome, not found, conflict, bug, infrastructure.`, r`Results for expected outcomes, exceptions for bugs and infrastructure; one convention.`, r`Stable error codes independent of messages.`, r`One mapper to ProblemDetails.`, r`In messaging, business rejections are events, not retries.`],
  ex: r`A card-authorisation service threw exceptions for every decline; at 4,000 declines per second during a fraud attack, exception overhead and logging doubled CPU and filled log storage. Moving declines to Result outcomes cut CPU by 40% and kept exceptions meaningful.`,
  fu: [r`How do you collect multiple business errors in one response?`, r`How do clients rely on error codes safely?`, r`Should domain exceptions be logged as errors?`],
  pit: [r`Exceptions as control flow for frequent business outcomes.`, r`Retrying business rejections from queues.`, r`Clients parsing error messages.`] },

{ id: 'q33', level: 'Senior', tags: ['ddd', 'team-topologies', 'conways-law', 'ownership'],
  q: r`How do you align bounded contexts with teams (Conway's Law, Team Topologies)? What happens when one team owns many contexts, or many teams share one context?`,
  a: r`### Conway's Law
Systems mirror the communication structure of the organisation. If two teams must coordinate on every change, their code will end up coupled; if one team owns a model, it stays coherent. Use this deliberately (the **inverse Conway manoeuvre**): design team boundaries to produce the architecture you want.

### Team Topologies mapping
- **Stream-aligned teams** own one or a few bounded contexts end to end (code, data, operations).
- **Platform teams** provide paved roads (deployment, observability, messaging) so stream teams stay autonomous.
- **Enabling teams** coach (DDD, testing).
- **Complicated-subsystem teams** own specialist contexts (pricing models, risk engines).

### Ownership patterns
| Situation | Effect | Response |
|---|---|---|
| One team, one context | ideal: clear ownership | |
| One team, several small related contexts | fine if cognitive load is manageable | keep contexts separate in code; regroup if load grows |
| Several teams in one context | coordination overhead, model drift, merge conflicts | split the context along a real language boundary, or make one team owner with others contributing via PRs |
| Context with no owner | decay | assign an owner or retire it |

### Cognitive load
A team can only hold so much domain knowledge. Too many contexts per team leads to shallow models; split ownership before quality drops.

### Make it visible
Context map with owning teams, on-call ownership per context, and integration contracts between teams.`,
  code: r`~~~text
Context map with owners (excerpt)

Context            Type         Owner team          Upstream of                Integration
Trade Capture      core         Trading Platform    Settlement, Risk, Reg      OHS + trade events v3
Settlement         core         Post-Trade          Ledger                     Customer-Supplier; ACL to CSD
Ledger             core         Finance Eng         Reporting                  Published language (journal v2)
Risk & Limits      core         Risk Tech           Trade Capture (reserve)    Sync API + limit events
Reference Data     supporting   Data Platform       everyone                   Conformist consumers
Onboarding/KYC     supporting   Client Journeys     Trade Capture              Events
Identity           generic      (bought: Entra ID)  everyone                   ACL
~~~
~~~text
# CODEOWNERS enforces context ownership in a modular monolith repo
/src/TradeCapture/   @org/trading-platform
/src/Settlement/     @org/post-trade
/src/Ledger/         @org/finance-eng
/src/Shared/Kernel/  @org/trading-platform @org/post-trade @org/finance-eng   # changes need all owners
~~~`,
  pts: [r`Architecture mirrors communication structure; design teams for the boundaries you want.`, r`Stream-aligned teams own contexts end to end; platform teams reduce load.`, r`Many teams in one context means drift: split or assign one owner.`, r`Respect cognitive load when assigning contexts.`, r`Publish owners on the context map, CODEOWNERS and on-call.`],
  ex: r`Three teams shared a "Customer" context; every sprint had cross-team merge conflicts and the model gained contradictory rules. Splitting it into Onboarding, Servicing and Risk Profile contexts, each with one owner, cut cross-team change requests by 70%.`,
  fu: [r`How do you reorganise teams without stopping delivery?`, r`What is the inverse Conway manoeuvre in practice?`, r`How do you handle a context that needs rare specialist knowledge?`],
  pit: [r`Contexts without owners.`, r`Many teams editing one model.`, r`Ignoring team cognitive load.`] },

{ id: 'q34', level: 'Senior', tags: ['ddd', 'temporal-modelling', 'effective-dating', 'bitemporal'],
  q: r`Model time correctly in a domain: effective-dated changes (a price or rate that applies from a date), corrections to the past, and the difference between "when it was true" and "when we recorded it".`,
  a: r`### Two axes
- **Valid (business) time**: when something is true in the world (rate 4.5% from 1 March).
- **Transaction (system) time**: when we recorded it (entered on 5 March).
Most domains need valid time explicitly; regulated ones need both (**bitemporal**) to answer "what did we believe on 3 March about the rate effective 1 March?".

### Effective-dated modelling
- Store versions with {{EffectiveFrom}} (and derived {{EffectiveTo}}) instead of overwriting.
- The domain asks "value **as of** date D".
- Future-dated changes are just versions with later effective dates.
- **Invariant**: no overlapping periods for the same key; contiguous coverage if required.

### Corrections
- A correction to the past is a **new version** with a new recorded time, not an edit in place.
- **Consequences**: interest already calculated with the old rate may need recalculation: a domain process ("rate correction" → recalculate affected loans → post adjustments), not a silent update.

### Implementation
- Value objects: {{DateRange}} / {{Period}} with overlap checks.
- Temporal tables (SQL Server) give system time automatically; valid time is modelled.
- Use {{DateOnly}} for business dates; UTC timestamps for recorded times; be explicit about time zones for cut-offs.`,
  code: r`~~~csharp
public sealed record Period(DateOnly From, DateOnly? To)
{
    public bool Contains(DateOnly d) => d >= From && (To is null || d < To);
    public bool Overlaps(Period o) => From < (o.To ?? DateOnly.MaxValue) && o.From < (To ?? DateOnly.MaxValue);
}

public sealed class InterestRateSchedule : AggregateRoot<ProductId>
{
    private readonly List<RateVersion> _versions = [];
    public decimal RateOn(DateOnly d) => _versions.Single(v => v.Period.Contains(d)).Rate;

    public void ScheduleChange(decimal rate, DateOnly from, UserId by, DateTimeOffset recordedAt)
    {
        var current = _versions.Single(v => v.Period.To is null);
        if (from <= current.Period.From) throw new DomainException("Use Correct() for changes on or before the current version");
        current.Close(from);                                                // contiguous coverage
        _versions.Add(new RateVersion(rate, new Period(from, null), by, recordedAt));
        Raise(new RateChangeScheduled(Id, rate, from));
    }

    public void Correct(DateOnly from, decimal correctedRate, string reason, UserId by, DateTimeOffset recordedAt)
    {
        // new version recorded now, valid from the past; old version kept for audit
        _versions.Add(RateVersion.Correction(correctedRate, from, reason, by, recordedAt, supersedes: _versions.Single(v => v.Period.Contains(from))));
        Raise(new RateCorrected(Id, from, correctedRate, reason));       // triggers recalculation process downstream
    }
}
~~~`,
  pts: [r`Separate valid time from recorded time; bitemporal for regulated history.`, r`Effective-dated versions instead of overwrites; ask "as of".`, r`No overlaps; contiguous coverage where required.`, r`Corrections are new versions plus domain processes for consequences.`, r`DateOnly for business dates, UTC for recorded times, explicit cut-off time zones.`],
  ex: r`A savings bank overwrote a product rate in place to fix a typo backdated two weeks; 60,000 accounts had interest accrued at the wrong rate with no record of the change. Effective-dated versions with a correction process made the next correction an auditable recalculation run.`,
  fu: [r`How do temporal tables and modelled valid time work together?`, r`How do you query "rates as known on date X for date Y"?`, r`How do you handle time zones for end-of-day cut-offs?`],
  pit: [r`Overwriting historical values.`, r`Using DateTime for business dates.`, r`Silent backdated changes without consequences handled.`] },

{ id: 'q35', level: 'Senior', tags: ['ddd', 'identity', 'strongly-typed-ids', 'cross-context'],
  q: r`Identity design across contexts: who generates ids, natural vs surrogate keys, strongly typed ids, correlating the same real-world thing across contexts, and exposing ids publicly.`,
  a: r`### Who generates ids
- **Client or application-generated** (GUID/UUIDv7, ULID): known before persistence, so aggregates can raise events with their id, commands are idempotent, and offline creation works.
- **Database-generated** (identity): compact, ordered, but unknown until insert.
Most DDD write models generate ids in the application (or use HiLo sequences) for these reasons; databases can still cluster on an internal bigint.

### Natural vs surrogate
Natural keys (IBAN, ISIN, national id, email) change, get corrected, or are reused. Keep them as **unique attributes** (alternate keys) and use surrogate ids for identity.

### Strongly typed ids
{{readonly record struct OrderId(Guid Value)}}: prevents mixing ids, documents signatures; needs converters for EF, JSON and routing.

### The same thing in several contexts
A customer exists in Sales, Billing and Support with different models. Correlate with a **shared global id** created by the context that first creates the concept (often the "system of record" for its existence) and propagated by events. Each context may also have local ids. Avoid each context inventing its own unrelated id for the same customer: correlation then needs matching logic.

### Public ids
Expose opaque ids (UUIDs) rather than sequential integers (enumeration attacks, leaking volumes). Never expose internal database keys of another context.`,
  code: r`~~~csharp
public readonly record struct CustomerId(Guid Value)
{
    public static CustomerId New() => new(Guid.CreateVersion7());                    // time-ordered, app-generated
    public override string ToString() => Value.ToString("N");
}

// The creating context issues the global id and propagates it
public sealed class Prospect : AggregateRoot<CustomerId>
{
    public static Prospect Register(LegalName name, EmailAddress email)
    {
        var p = new Prospect(CustomerId.New(), name, email);
        p.Raise(new CustomerRegistered(p.Id, name, email));                          // other contexts adopt this id
        return p;
    }
}

// Natural key as unique attribute, not identity
modelBuilder.Entity<Instrument>().HasKey(i => i.Id);
modelBuilder.Entity<Instrument>().HasIndex(i => i.Isin).IsUnique();

// Converters for typed ids: EF, JSON and minimal-API binding
modelBuilder.Entity<Prospect>().Property(p => p.Id).HasConversion(id => id.Value, v => new CustomerId(v));
public sealed class CustomerIdJsonConverter : JsonConverter<CustomerId>
{
    public override CustomerId Read(ref Utf8JsonReader r, Type t, JsonSerializerOptions o) => new(r.GetGuid());
    public override void Write(Utf8JsonWriter w, CustomerId v, JsonSerializerOptions o) => w.WriteStringValue(v.Value);
}
~~~`,
  pts: [r`Application-generated ids enable events and idempotency before persistence.`, r`Natural keys are unique attributes, not identities.`, r`Strongly typed ids prevent mix-ups; add EF, JSON and binding converters.`, r`One global id per real-world concept, issued by the creating context.`, r`Expose opaque ids, never sequential or another context's keys.`],
  ex: r`A bank's CRM, lending and cards systems each created their own customer number; linking them needed a nightly fuzzy-matching job that mis-merged 0.4% of customers, causing statements sent to the wrong people. A global customer id issued at onboarding and carried in events ended the matching.`,
  fu: [r`UUIDv7 vs ULID vs snowflake ids: trade-offs?`, r`How do you migrate from database ids to application-generated ids?`, r`How do you merge two customer records that turn out to be one person?`],
  pit: [r`Natural keys as primary keys.`, r`Sequential public ids.`, r`Each context inventing ids for shared concepts.`] },

{ id: 'q36', level: 'Senior', tags: ['ddd', 'variability', 'composition', 'strategy'],
  q: r`A lender offers fixed-rate, variable-rate, interest-only and buy-now-pay-later products with different repayment and fee rules. Model the variability: inheritance, composition with policies, or separate aggregates per product?`,
  a: r`### Inheritance ({{Loan}} → {{FixedRateLoan}}, {{VariableRateLoan}})
Tempting, but products combine features (variable **and** interest-only **and** offset), leading to class explosion or deep hierarchies; switching a loan's product mid-life (fixed period ends, becomes variable) is awkward because an object cannot change its class. ORM inheritance mapping adds friction.

### Composition with policies (usually best)
One {{Loan}} aggregate holds the invariants common to all loans (balance, schedule integrity, status lifecycle) and **delegates varying behaviour** to policy value objects: {{IInterestPolicy}} (fixed, variable with index and margin, promotional), {{IRepaymentPolicy}} (amortising, interest-only, instalments), {{IFeePolicy}}. Product configuration chooses the policies; a product switch replaces a policy with an event ({{InterestPolicyChanged}}).

### Separate aggregates or contexts
When products differ in **lifecycle and invariants**, not just calculations (BNPL instalments at a merchant vs a 25-year mortgage with regulatory processes), they are different models: separate aggregates, possibly separate contexts with their own language. Forcing them into one Loan creates a lowest-common-denominator model.

### Deciding
- Same lifecycle, different calculations → composition.
- Different lifecycles, rules and experts → separate models.
- Inheritance only for small, closed, stable variations.`,
  code: r`~~~csharp
public interface IInterestPolicy { Money InterestFor(Money balance, Period period, IRateSource rates); string Describe(); }
public sealed record FixedRate(decimal AnnualRate, DateOnly FixedUntil) : IInterestPolicy
{
    public Money InterestFor(Money b, Period p, IRateSource _) => b.Multiply(AnnualRate * p.Days / 365m);
    public string Describe() => $"Fixed {AnnualRate:P2} until {FixedUntil}";
}
public sealed record IndexTracker(string Index, decimal Margin) : IInterestPolicy
{
    public Money InterestFor(Money b, Period p, IRateSource rates) => b.Multiply((rates.Average(Index, p) + Margin) * p.Days / 365m);
    public string Describe() => $"{Index} + {Margin:P2}";
}

public sealed class Loan : AggregateRoot<LoanId>
{
    public Money Balance { get; private set; }
    public IInterestPolicy Interest { get; private set; }
    public IRepaymentPolicy Repayment { get; private set; }

    public void AccrueInterest(Period p, IRateSource rates)
    {
        var interest = Interest.InterestFor(Balance, p, rates);
        Balance = Balance.Add(interest);
        Raise(new InterestAccrued(Id, p, interest, Interest.Describe()));
    }

    public void SwitchToFollowOnRate(IInterestPolicy followOn, DateOnly on)
    {
        if (Interest is FixedRate f && on < f.FixedUntil) throw new DomainException("Fixed period not ended");
        Interest = followOn;
        Raise(new InterestPolicyChanged(Id, followOn.Describe(), on));
    }
}
~~~`,
  pts: [r`Inheritance explodes with feature combinations and cannot change type mid-life.`, r`Composition: one aggregate with interchangeable policy value objects.`, r`Policy switches are explicit domain events.`, r`Different lifecycles and invariants mean separate models.`, r`Inheritance only for small, closed, stable variations.`],
  ex: r`A mortgage platform had 14 Loan subclasses; adding an offset feature to three of them required six new classes. Refactoring to interest and repayment policies reduced the hierarchy to one Loan class and made the next product launch a configuration change plus one new policy.`,
  fu: [r`How do you persist polymorphic policy value objects with EF Core?`, r`How do you explain a policy change on a customer statement?`, r`When would BNPL deserve its own bounded context?`],
  pit: [r`Deep inheritance hierarchies for products.`, r`Switch statements on product type throughout the code.`, r`One model forced on products with different lifecycles.`] },

{ id: 'q37', level: 'Principal', tags: ['ddd', 'decomposition', 'capital-markets', 'case-study'],
  q: r`Decompose a capital-markets platform (trade capture, risk and limits, settlement, ledger, reference data, client onboarding, regulatory reporting) into bounded contexts. Explain the context map, where money invariants live, and how you sequence the work.`,
  a: r`### Discovery
Big-picture Event Storming with traders, operations, risk, finance and compliance. Pivotal events: {{TradeBooked}}, {{TradeConfirmed}}, {{TradeSettled}}, {{PositionClosed}}; language shifts ("trade" vs "settlement instruction" vs "journal") mark boundaries.

### Contexts
| Context | Type | Owns |
|---|---|---|
| Trade Capture | core | trade lifecycle, amendments, confirmations |
| Risk & Limits | core | real-time exposure, limit reservations |
| Settlement | core | settlement instructions, matching with custodians |
| Ledger | core | double-entry journal, balances, the money invariant |
| Reference Data | supporting | instruments, calendars, counterparties |
| Onboarding / KYC | supporting | client lifecycle, documents, screening |
| Regulatory Reporting | supporting | MiFIR/EMIR reports from events |
| Identity, Notifications | generic | bought |

### Relationships
- Trade Capture is **OHS + published language** (trade events) for Settlement, Risk, Reporting.
- Settlement → Ledger: **customer-supplier**; Ledger publishes a strict journal language.
- Settlement → custodians/CSDs: **ACL**.
- Reference Data: upstream, most consumers **conformist**.

### Money invariants
Only the **Ledger** decides balances (small account aggregates, append-only entries, balanced journals). Other contexts never compute "the" balance; they consume ledger events or ask it.

### Sequencing
1. Start where boundaries are clearest and value highest (often Ledger or Trade Capture).
2. Publish contracts early; let consumers move one at a time.
3. Keep supporting contexts simple; buy generic ones.
4. Governance from day one: dependency direction tests, contract tests, ownership.`,
  dia: r`flowchart LR
  TC[Trade Capture] -->|OHS: trade events| ST[Settlement]
  TC -->|OHS: trade events| RK[Risk and Limits]
  RK -->|sync reserve limit| TC
  TC -->|events| REG[Regulatory Reporting]
  ST -->|Customer-Supplier| LG[Ledger]
  ST -->|ACL| CSD[Custodians and CSDs]
  LG -->|journal events| REG
  RD[Reference Data] -->|Conformist| TC
  RD --> ST
  ON[Onboarding KYC] -->|ClientApproved| TC`,
  code: r`~~~csharp
// Published language from Trade Capture
namespace TradeCapture.Contracts.V3;
public sealed record TradeBooked(Guid TradeId, string Book, string Isin, string Side, decimal Quantity,
    decimal Price, string Currency, DateOnly TradeDate, DateOnly SettlementDate, Guid CounterpartyId, long Version);

// Ledger: the only place money balances are decided
public sealed class LedgerAccount : AggregateRoot<LedgerAccountId>
{
    public Money Balance { get; private set; }
    public Money Floor { get; private set; }
    public void Post(JournalLine line)
    {
        if (line.Amount.Currency != Balance.Currency) throw new DomainException("Currency mismatch");
        var next = Balance.Add(line.Amount);
        if (next < Floor) throw new DomainException("Posting breaches account floor");
        Balance = next;
        Touch();
    }
}

// Architecture test: upstream contexts never depend on downstream ones
[Fact]
public void TradeCapture_does_not_depend_on_Settlement_or_Ledger() =>
    Assert.True(Types.InAssembly(typeof(TradeCapture.Domain.Trade).Assembly)
        .ShouldNot().HaveDependencyOnAny("Settlement", "Ledger").GetResult().IsSuccessful);
~~~`,
  pts: [r`Discover with Event Storming; pivotal events and language shifts define contexts.`, r`Trade Capture as OHS; ACLs to custodians; conformist reference data.`, r`Money invariants only in the Ledger.`, r`Sequence by clarity and value; publish contracts early.`, r`Governance from day one: dependency tests, contracts, owners.`],
  ex: r`A broker's first decomposition split services by entity (TradeService, AccountService, PositionService), all sharing one database; every release touched four services. Re-drawing around Trade Capture, Settlement and Ledger contexts cut cross-service changes by 80% within a year.`,
  fu: [r`Where does position-keeping belong?`, r`How does Regulatory Reporting cope with late amendments?`, r`Which context would you build first and why?`],
  pit: [r`Entity-based service splits.`, r`Balances computed in several contexts.`, r`Decomposing everything at once.`] },

{ id: 'q38', level: 'Principal', tags: ['ddd', 'cross-context-invariants', 'limits', 'consistency'],
  q: r`A credit limit owned by Risk must never be breached by trades booked in Trade Capture, which runs at 2,000 trades per second. Design how the invariant is enforced across contexts, including failure modes.`,
  a: r`### Principle
**One context is authoritative for an invariant.** Risk owns limits and exposure; Trade Capture must not enforce limits from a replicated copy (stale copies allow concurrent breaches).

### Options
1. **Synchronous reservation at the decision point**: Trade Capture calls Risk {{Reserve(counterparty, amount, tradeId)}} before accepting the trade. Risk's small exposure aggregate (per counterparty, possibly sharded) accepts or rejects atomically. Strong, simple; couples availability and latency (Risk must be fast and highly available).
2. **Reservation saga**: accept the trade provisionally, reserve asynchronously, cancel or flag the trade on rejection. Higher availability; allows brief breaches or provisional states the business must accept.
3. **Pre-allocated headroom**: Risk grants Trade Capture a **block of limit** per counterparty (a lease); Trade Capture consumes locally and returns or requests more. Fast and available; slight underutilisation of limits; Risk stays authoritative over the total.

### Choice at 2,000 trades/s
Option 1 for large or unusual trades and option 3 (headroom leases) for high-frequency flow, with Risk's reservation aggregate designed for hot counterparties (sharded exposure counters, in-memory single-writer per counterparty with durable log).

### Failure modes
- Risk unavailable: fail closed for new exposure (reject or queue for manual approval) unless headroom remains; a business decision documented upfront.
- Reservation succeeded but trade booking failed: reservations expire (TTL) or are released by a compensating event.
- Duplicate reservation requests: idempotent by trade id.
- Reconciliation: periodic comparison of booked trades vs reservations; alerts on drift.`,
  dia: r`sequenceDiagram
  participant T as Trade Capture
  participant R as Risk and Limits
  T->>R: Reserve counterparty C amount for trade 42
  R-->>T: Reserved with reservation id
  T->>T: Book trade 42
  T-->>R: TradeBooked event confirms reservation
  Note over T,R: If booking fails, reservation expires or is released
  R->>T: Grant headroom lease for C
  T->>T: Consume headroom locally for small trades`,
  code: r`~~~csharp
// Risk context: authoritative exposure aggregate with idempotent, expiring reservations
public sealed class CounterpartyExposure : AggregateRoot<CounterpartyId>
{
    public Money Limit { get; private set; }
    public Money Used { get; private set; }
    private readonly Dictionary<Guid, Reservation> _reservations = new();

    public ReservationResult Reserve(Guid tradeId, Money amount, DateTimeOffset now)
    {
        if (_reservations.TryGetValue(tradeId, out var existing)) return ReservationResult.Ok(existing.Id);   // idempotent
        ExpireStale(now);
        if (Used.Add(amount) > Limit) return ReservationResult.Rejected("limit.exceeded");
        var r = new Reservation(Guid.NewGuid(), tradeId, amount, now.AddMinutes(5));
        _reservations[tradeId] = r; Used = Used.Add(amount); Touch();
        return ReservationResult.Ok(r.Id);
    }

    public HeadroomLease GrantHeadroom(Money block, DateTimeOffset now)
    {
        if (Used.Add(block) > Limit) block = Limit.Subtract(Used);
        Used = Used.Add(block); Touch();
        return new HeadroomLease(Id, block, now.AddMinutes(1));            // unused headroom returned on expiry
    }
}

// Trade Capture: fail closed when Risk is unavailable and no headroom remains
var res = await risk.ReserveAsync(trade.Counterparty, trade.Exposure, trade.Id, ct)
          .WaitAsync(TimeSpan.FromMilliseconds(50), ct);
if (!res.Succeeded) return trade.Reject(res.Reason);
~~~`,
  pts: [r`One authoritative context per invariant; no enforcement from replicas.`, r`Synchronous reservation, reservation saga, or headroom leases.`, r`High throughput: headroom leases plus sharded or single-writer exposure.`, r`Fail closed when the authority is down, by documented business decision.`, r`Expiring idempotent reservations and reconciliation for drift.`],
  ex: r`A bank's trading platform checked limits against a replicated exposure table refreshed every 10 seconds; during a volatile open, three desks breached a counterparty limit by 40 million USD. Moving to reservations with headroom leases closed the window while keeping latency under 2 ms.`,
  fu: [r`How big should a headroom lease be?`, r`What happens to reservations when a trade is amended?`, r`How do you test the fail-closed path?`],
  pit: [r`Each context checking limits from its own copy.`, r`Reservations that never expire.`, r`Undocumented behaviour when the limit service is down.`] },

{ id: 'q39', level: 'Principal', tags: ['ddd', 'adoption', 'organisation', 'change'],
  q: r`Your organisation builds database-first CRUD services and has never used DDD. How do you introduce it so it delivers results rather than ceremony?`,
  a: r`### Start strategic and small
1. Pick **one painful, complex, core** area (frequent defects, slow rule changes, unhappy business owners), not a greenfield toy.
2. Run **Event Storming** with real domain experts; produce a glossary and a draft context map. This alone often fixes misunderstandings.
3. Define that area's **bounded context**: its language, its data, its contracts.

### Model richly only there
- Aggregates and value objects where invariants matter; leave CRUD screens and reference data as simple code.
- Tests in the ubiquitous language that experts review.

### Show measurable wins
Lead time for rule changes, defect rate in that area, incidents, time for new developers to understand rules. Publish before/after numbers.

### Spread through enablement, not mandates
- Pairing and mob sessions on real code.
- A **reference implementation** and templates (solution layout, outbox, architecture tests).
- An internal community of practice; Event Storming facilitation as a skill several people hold.
- Architecture reviews ask strategic questions (boundaries, ownership, contracts) before tactical ones.

### Avoid
- Mandating aggregates and repositories everywhere.
- Big-bang rewrites.
- Pattern vocabulary without domain experts in the room.
- Treating DDD as a folder structure.`,
  code: r`~~~text
90-day plan (example)

Weeks 1-2   Select area: "fee calculation and billing" (40% of production defects last year)
Weeks 2-3   Big-picture + process-level Event Storming with finance ops, product, engineering
            Output: glossary (62 terms), 9 hot spots, context map draft, Fees context proposal
Weeks 4-10  Build Fees context beside the monolith (ACLs both ways), rich model for fee rules,
            shadow mode against legacy calculations, discrepancy reviews with finance
Weeks 10-12 Cut over by merchant segment; publish metrics:
            - rule-change lead time 3 weeks -> 2 days
            - fee-related defects 11/quarter -> 1/quarter
Ongoing     Reference implementation repo, 2 trained facilitators, monthly DDD clinic
~~~
~~~csharp
// The reference implementation teams copy: small, real, opinionated
public sealed class FeeSchedule : AggregateRoot<FeeScheduleId>
{
    public FeeDecision Decide(Transaction t) { /* rules in the language finance uses */ return default!; }
}
~~~`,
  pts: [r`Start with one painful core area and real experts.`, r`Strategic first: language, context, contracts.`, r`Rich modelling only where invariants matter.`, r`Measure and publish outcomes.`, r`Spread via pairing, reference implementations and facilitators, not mandates.`],
  ex: r`An insurer's first DDD attempt was a mandate requiring aggregates in every service; it produced ceremony and resentment. The second attempt focused on claims assessment only, showed a halving of rule-change lead time, and teams then asked for Event Storming sessions themselves.`,
  fu: [r`How do you get domain experts' time?`, r`What do you say to engineers who see DDD as over-engineering?`, r`Which metrics convince executives?`],
  pit: [r`Mandating tactical patterns.`, r`Greenfield toy pilots.`, r`No experts in modelling sessions.`] },

{ id: 'q40', level: 'Principal', tags: ['ddd', 'anti-patterns', 'distributed-monolith', 'redesign'],
  q: r`You inherit 30 microservices split by entity (CustomerService, AccountService, TransactionService...) that must be deployed together and constantly call each other. Diagnose it in DDD terms and lead the redesign.`,
  a: r`### Diagnosis
- **Entity services**, not capabilities: every business use case spans several services (opening an account touches Customer, Account, Product, Limit services).
- **Chatty synchronous calls** and shared data: services are a distributed monolith with network failures added.
- **No bounded contexts**: one enterprise model split across processes; the same "Account" meaning everywhere.
- Symptoms: coordinated releases, cascading failures, distributed transactions or none at all (inconsistency), slow delivery.

### Evidence to gather
- **Change coupling** from git: which services change together in the same feature.
- Call graphs and latency from tracing: synchronous call depth per use case.
- Incidents caused by cross-service consistency.
- Team ownership vs service ownership.

### Redesign
1. Event Storming of the main value streams to find **capabilities and language boundaries**.
2. Draw target contexts (Onboarding, Accounts & Ledger, Payments, Cards, Lending) and map current services onto them.
3. **Merge** services that always change together into one context (often into a modular monolith first), and **split** services that mix contexts.
4. Replace synchronous chains with events or local data where autonomy matters; keep synchronous calls for authoritative decisions.
5. Move data ownership to the target contexts; remove shared tables.
6. Migrate incrementally with strangler steps, measuring change coupling and lead time.

### Communicating
Frame it in business terms: lead time, incident rate, cost of coordination. Merging services is not a step backwards; it is fixing the boundaries.`,
  dia: r`flowchart LR
  subgraph Before[Entity services]
    C[CustomerService] <--> A[AccountService]
    A <--> T[TransactionService]
    T <--> L[LimitService]
    C <--> L
  end
  subgraph After[Capability contexts]
    O[Onboarding] -->|CustomerOnboarded| AL[Accounts and Ledger]
    P[Payments] -->|reserve and post| AL
    CA[Cards] -->|authorise| AL
  end
  Before -. strangler migration .-> After`,
  code: r`~~~bash
# Change coupling: which services change together in the same commits (last 6 months)
git log --since="6 months ago" --name-only --pretty=format:"--%H" \
 | awk '/^--/{if(n){for(a in s)for(b in s)if(a<b)print a" "b};delete s;n=0;next} {split($0,p,"/"); if(p[1]=="services"){s[p[2]]=1;n++}}' \
 | sort | uniq -c | sort -rn | head -15
#  412 AccountService CustomerService
#  388 AccountService TransactionService
#  301 LimitService TransactionService
~~~
~~~csharp
// After: one context owns the account invariant and its transactions
public sealed class Account : AggregateRoot<AccountId>
{
    public LedgerEntry Post(Money amount, PostingRef reference) { /* balance + limits in one boundary */ return default!; }
}
~~~`,
  pts: [r`Entity services create distributed monoliths: every use case spans services.`, r`Gather change coupling, call depth and incident data.`, r`Redraw around capabilities found by Event Storming.`, r`Merge what changes together; split what mixes contexts.`, r`Migrate incrementally and measure lead time and coupling.`],
  ex: r`A neobank had 34 entity services requiring a release train every two weeks; change-coupling analysis showed six clusters. Consolidating into six context-aligned services (two as a modular monolith) enabled independent daily deploys and halved incident count within two quarters.`,
  fu: [r`How do you convince leadership that merging services is progress?`, r`How do you migrate data ownership without downtime?`, r`What metrics prove the redesign worked?`],
  pit: [r`Splitting by nouns.`, r`Adding an orchestration layer on top instead of fixing boundaries.`, r`Big-bang re-architecture.`] },

{ id: 'q41', level: 'Principal', tags: ['ddd', 'governance', 'fitness-functions', 'context-map'],
  q: r`The platform has grown to 40 bounded contexts and 15 teams. How do you govern context boundaries and integration so they stay healthy without central bottlenecks?`,
  a: r`### Make the architecture visible
- A **living context map** (as code or a catalogue: Backstage, Structurizr) listing contexts, owners, type (core/supporting/generic), upstream/downstream relationships and published contracts.
- An **event and API catalogue** (AsyncAPI/OpenAPI) with owners and consumers.

### Automate the rules (fitness functions)
- Dependency direction tests (no upstream depends on downstream; no references to other contexts' internals).
- **No cross-context database access**: separate schemas/databases, credentials per context, scanners for cross-schema SQL.
- Contract compatibility checks and consumer-driven contract tests in CI.
- Change-coupling reports per quarter: contexts that change together are candidates for merging or a missing contract.

### Decision process
- **ADRs** for boundary changes (new context, split, merge, new relationship), reviewed by affected teams, not a central committee.
- An architecture forum for cross-cutting decisions; platform team provides paved roads (outbox, inbox, contract tooling).
- Clear escalation for disputes about ownership.

### Health signals
Lead time, deployment independence (percentage of deploys requiring coordination), incidents crossing contexts, contract breakages, number of synchronous call hops per use case.

### Avoid
Central architects approving every change; diagrams that are never updated; "shared" contexts with no owner.`,
  code: r`~~~yaml
# context-map.yaml (source of truth, rendered in the developer portal and checked in CI)
contexts:
  - name: payments
    type: core
    owner: team-payments
    publishes: [payments.captured.v2, payments.refunded.v1]
    upstream:
      - context: ledger
        relationship: customer-supplier
      - context: reference-data
        relationship: conformist
    database: sql://payments-db (schema payments)
  - name: ledger
    type: core
    owner: team-finance-eng
    publishes: [ledger.journal-posted.v2]
~~~
~~~csharp
// Fitness function generated from the context map: only declared upstream relationships are allowed
[Theory, MemberData(nameof(ContextMap.Contexts), MemberType = typeof(ContextMap))]
public void Context_only_depends_on_declared_upstreams(ContextDefinition ctx)
{
    var forbidden = ContextMap.AllContextNames.Except(ctx.Upstreams.Select(u => u.Context)).Except([ctx.Name]);
    var result = Types.InAssembly(ctx.Assembly).ShouldNot().HaveDependencyOnAny(forbidden.Select(n => n + ".").ToArray()).GetResult();
    Assert.True(result.IsSuccessful, $"{ctx.Name} has undeclared dependencies: {string.Join(", ", result.FailingTypeNames ?? [])}");
}
~~~`,
  pts: [r`Living context map and contract catalogue with owners.`, r`Fitness functions: dependency direction, no cross-context DB access, contract compatibility.`, r`ADRs reviewed by affected teams instead of central approval.`, r`Track coupling, coordinated deploys and cross-context incidents.`, r`Paved roads make the right integration easy.`],
  ex: r`A payments group's context map lived in a slide deck from three years earlier. Moving it to a YAML file checked by CI exposed 11 undeclared dependencies, two of which were direct queries into another context's database that had caused a production incident.`,
  fu: [r`Who resolves an ownership dispute between two teams?`, r`How do you detect cross-context database access in practice?`, r`How often should the context map be reviewed?`],
  pit: [r`Central approval of every change.`, r`Stale architecture diagrams.`, r`Contexts with no owner.`] },

{ id: 'q42', level: 'Principal', tags: ['ddd', 'boundaries', 'refactoring', 'evolution'],
  q: r`Bounded contexts are not permanent. What signals tell you a context should be split or two contexts merged, and how do you execute either change safely?`,
  a: r`### Signals to split
- Two sub-languages inside one context ("policy" means different things to underwriting and to claims).
- Different rates of change, stakeholders or compliance regimes in parts of the model.
- One team cannot hold the cognitive load; or two teams fight over one codebase.
- Different scaling or availability needs (a real-time part and a batch part).

### Signals to merge
- Two contexts change together in most features (high change coupling).
- Chatty synchronous calls or many events just to keep each other consistent.
- Invariants that span both, requiring sagas for what is really one consistency boundary.
- One small team owns both and the split only adds overhead.

### Executing a split
1. Model the two languages; decide which aggregates and data go where.
2. Inside the existing service, separate into modules with their own schemas first (a modular split).
3. Introduce contracts (events/APIs) between the new modules; replace shared-table access.
4. Extract into separate deployables only if needed.
5. Migrate consumers to the new contracts; keep old contracts via adapters during transition.

### Executing a merge
1. Merge code into one deployable as two modules; route integration in-process.
2. Unify the model where the language really is one; delete translation layers.
3. Merge schemas carefully (data migration, id mapping).
4. Retire redundant events and contracts with deprecation periods.

### Either way
ADR with the evidence, incremental steps, consumer communication, and before/after metrics.`,
  code: r`~~~text
Split decision record (ADR-0142): "Policy" context -> "Underwriting" + "Policy Administration"

Evidence
  - Glossary conflict: "policy version" (underwriting quote iterations) vs "policy version" (endorsements)
  - Change coupling inside the context: two clusters with 6% overlap over 12 months
  - Two teams, 31 merge conflicts last quarter
Plan
  1. Modules + schemas inside current service (Q1)
  2. QuoteAccepted event as the contract between them (Q1)
  3. Extract Underwriting deployable (Q2) - needed for separate scaling of pricing
  4. Consumers of PolicyChanged.v3 migrate to PolicyIssued / EndorsementApplied (Q2-Q3)
Metrics: merge conflicts, lead time, cross-team change requests
~~~
~~~csharp
// Transitional adapter keeps an old contract alive while consumers migrate
public sealed class LegacyPolicyChangedPublisher : IEventHandler<EndorsementApplied>, IEventHandler<PolicyIssued>
{
    public Task Handle(EventEnvelope<EndorsementApplied> e, CancellationToken ct) => Publish(PolicyChangedV3.From(e.Data), ct);
    public Task Handle(EventEnvelope<PolicyIssued> e, CancellationToken ct) => Publish(PolicyChangedV3.From(e.Data), ct);
    private Task Publish(PolicyChangedV3 v3, CancellationToken ct) => outbox.AddAsync(v3, ct);   // removed after deprecation date
}
~~~`,
  pts: [r`Split on language conflicts, divergent change, team load, different scaling needs.`, r`Merge on high change coupling, chatty consistency, spanning invariants.`, r`Split as modules first, then contracts, then deployables.`, r`Merges unify models and retire translation layers.`, r`ADR with evidence; transitional adapters for consumers; measure.`],
  ex: r`Two contexts, Pricing and Quoting, were split early in a lending platform; 85% of features touched both and a saga existed just to keep quotes and prices consistent. Merging them removed the saga and two event types, and quote lead time improved by a third.`,
  fu: [r`How do you migrate consumers off an old combined event?`, r`What if a merge creates a context too big for one team?`, r`How long should transitional adapters live?`],
  pit: [r`Treating initial boundaries as permanent.`, r`Splitting directly into services without a modular step.`, r`Breaking consumers during splits.`] },

{ id: 'q43', level: 'Principal', tags: ['ddd', 'ledger', 'double-entry', 'core-domain'],
  q: r`Model a ledger as a core bounded context: journals, postings, accounts, balances, holds, reversals and period closing. What are the aggregates, the invariants, and the published language for other contexts?`,
  a: r`### Language
**Journal entry** (one business event, many postings), **posting** (debit or credit to one account), **account** (with type: asset, liability, revenue, expense; currency), **balance** (derived), **hold** (reserved funds), **reversal** (an opposite entry, never a delete), **period close**.

### Aggregates and invariants
| Aggregate | Invariant |
|---|---|
| **JournalEntry** | postings **sum to zero per currency**; immutable once posted; idempotent by source reference |
| **Account** (small) | available balance ≥ floor/overdraft; status allows posting; currency matches |
| **Hold** | held amount ≤ available at creation; expires or converts to a posting |
| **AccountingPeriod** | no postings into a closed period (corrections go to the open period with reference) |

Balances are **derived** from postings; the Account aggregate keeps a running balance updated in the same transaction as postings for fast checks, and a reconciliation verifies it against the sum of postings.

### Rules
- **Append-only**: corrections are reversals plus new entries.
- **Idempotency** by source system reference (payment id, trade id).
- Multi-currency: each posting has a currency; FX conversion is explicit postings through FX accounts.
- Effective date vs booking date.

### Published language
{{JournalPosted}} events (entry id, source reference, postings with account, amount, currency, effective date), balance query API, statements. Consumers never write to the ledger directly; they send **posting requests** that the ledger validates.`,
  code: r`~~~csharp
public sealed class JournalEntry : AggregateRoot<JournalEntryId>
{
    private readonly List<Posting> _postings = [];
    public SourceReference Source { get; }                   // unique: idempotency
    public DateOnly EffectiveDate { get; }
    public IReadOnlyList<Posting> Postings => _postings;

    public static JournalEntry Create(SourceReference source, DateOnly effective, IEnumerable<Posting> postings, AccountingPeriod period)
    {
        if (period.IsClosed) throw new DomainException($"Period {period.Name} is closed");
        var list = postings.ToList();
        if (list.Count < 2) throw new DomainException("A journal needs at least two postings");
        foreach (var g in list.GroupBy(p => p.Amount.Currency))
            if (g.Sum(p => p.Amount.Amount) != 0m) throw new UnbalancedJournalException(g.Key);
        var e = new JournalEntry(JournalEntryId.New(), source, effective);
        e._postings.AddRange(list);
        e.Raise(new JournalPosted(e.Id, source, effective, list));
        return e;
    }

    public JournalEntry Reverse(SourceReference reversalSource, DateOnly effective, AccountingPeriod period) =>
        Create(reversalSource, effective, _postings.Select(p => p with { Amount = p.Amount.Negate() }), period);
}

// Card purchase settled: customer liability debited, merchant settlement account credited, fee to revenue
var entry = JournalEntry.Create(new SourceReference("card-settlement", settlementId), today,
[
    Posting.Debit(customerAccount, Money.Gbp(100.00m)),
    Posting.Credit(merchantSettlement, Money.Gbp(98.50m)),
    Posting.Credit(feeRevenue, Money.Gbp(1.50m)),
], currentPeriod);
~~~`,
  pts: [r`Journal entries balance per currency and are immutable.`, r`Small Account aggregates enforce floors; balances derived and reconciled.`, r`Append-only: reversals, never deletes; closed periods reject postings.`, r`Idempotency by source reference.`, r`Publish JournalPosted; others submit posting requests, never write directly.`],
  ex: r`A wallet company stored balances as mutable columns updated by several services; a bug updated a balance without a matching transaction and 1.8 million GBP of discrepancies took two months to unpick. A ledger context with balanced, append-only journals made every balance explainable posting by posting.`,
  fu: [r`How do you model holds and their conversion to postings?`, r`How do you handle FX within one journal entry?`, r`How do you close a period when late events arrive?`],
  pit: [r`Mutable balances without postings.`, r`Deleting or editing posted entries.`, r`Multiple contexts writing to the ledger tables.`] },

{ id: 'q44', level: 'Principal', tags: ['ddd', 'canonical-model', 'design-review', 'master-data'],
  q: r`Design review: an enterprise architecture group proposes one central Customer service with a canonical Customer model that every system must use. How do you respond, and what do you propose instead?`,
  a: r`### What goes wrong with a canonical model
- Every context needs different customer data and rules; the canonical model accumulates all of them (hundreds of fields, contradictory validations).
- Every change requires agreement from all consumers: the central team becomes a **bottleneck**, and releases couple.
- Runtime coupling: every use case in every context calls the Customer service; its outage stops the company.
- Ownership blurs: nobody can evolve the model to fit their domain.

### What the proposal is really trying to solve
Usually legitimate needs: **one identity** for a customer across systems, consistent **golden data** for a few attributes (legal name, contact details), regulatory views (single customer view), and reduced duplication of KYC.

### Counter-proposal
1. A **Party/Identity context** (or MDM capability) that owns **identity and a small set of core attributes**, issues the global customer id, and publishes {{CustomerRegistered}}, {{CustomerDetailsChanged}}.
2. Each context keeps **its own customer model** (Billing account, Lending borrower, Support contact) keyed by the global id, holding only what it needs, updated from events (event-carried state transfer) or captured at the moment of a fact.
3. A **single customer view** for regulators and support built as a **read model** that aggregates from contexts, not as the write model everyone depends on.
4. Clear ownership of each attribute (who is the system of record for address? for risk rating?).

### How to land it
Agree on the goals, show the coupling costs with examples, propose a pilot, and frame the change as delivering the same goals with less coordination.`,
  dia: r`flowchart LR
  P[Party context: global id + core attributes] -->|CustomerRegistered, DetailsChanged| B[Billing: BillingAccount]
  P --> L[Lending: Borrower]
  P --> S[Support: Contact]
  B --> V[Single customer view read model]
  L --> V
  S --> V
  P --> V`,
  code: r`~~~csharp
// Party context: owns identity and a few golden attributes only
public sealed class Party : AggregateRoot<PartyId>
{
    public LegalName Name { get; private set; }
    public PostalAddress RegisteredAddress { get; private set; }
    public DateOnly? DateOfBirth { get; private set; }
    public void ChangeRegisteredAddress(PostalAddress a, ChangeSource source)
    {
        RegisteredAddress = a;
        Raise(new PartyDetailsChanged(Id, Name, a, Version + 1));
    }
}

// Lending context: its own model keyed by the global id
public sealed class Borrower : AggregateRoot<PartyId>
{
    public AffordabilityAssessment? LatestAssessment { get; private set; }
    public CreditGrade Grade { get; private set; }
    public LegalName NameAtLastUpdate { get; private set; }       // local copy from events
}

// Single customer view: a read model assembled from many contexts, never written to by them
public sealed record CustomerView(Guid PartyId, string Name, IReadOnlyList<ProductHolding> Products, IReadOnlyList<OpenCase> Cases);
~~~`,
  pts: [r`Canonical models bloat, centralise change and couple runtime availability.`, r`Identify the real goals: identity, golden attributes, single view.`, r`Party context owns identity and a few attributes; contexts own their models.`, r`Single customer view as a read model.`, r`Assign a system of record per attribute.`],
  ex: r`A bank's canonical customer service took on 600 fields over five years; every product launch waited months for schema changes and its outages halted onboarding, payments and support at once. Re-scoping it to identity plus 20 attributes, with context-owned models, cut its change queue to near zero.`,
  fu: [r`Who owns the customer's address when several channels can change it?`, r`How do you build a single customer view for regulators?`, r`How do you migrate consumers off the canonical model?`],
  pit: [r`Canonical enterprise models.`, r`Synchronous dependency on one central service for every use case.`, r`No owner per attribute.`] },

{ id: 'q45', level: 'Principal', tags: ['ddd', 'payments', 'domain-model', 'contexts'],
  q: r`Design the domain model of a card-acquiring payments platform across contexts: authorisation, capture, settlement, merchant funding, disputes and ledger. Which context owns which concepts and events?`,
  a: r`### Contexts and their language
| Context | Concepts | Key events |
|---|---|---|
| **Authorisation** (core, real-time) | authorisation request, risk decision, scheme response | {{PaymentAuthorised}}, {{PaymentDeclined}} |
| **Payment lifecycle** (core) | payment, capture, refund, void | {{PaymentCaptured}}, {{PaymentRefunded}} |
| **Clearing & Settlement** (core) | scheme files, settlement batches, interchange | {{SettlementBatchReceived}}, {{TransactionSettled}} |
| **Merchant Funding** (core) | payouts, reserves, fees, netting | {{PayoutScheduled}}, {{PayoutSent}} |
| **Disputes** (supporting) | chargebacks, representment, evidence | {{ChargebackReceived}}, {{DisputeWon}} |
| **Ledger** (core) | journals, accounts, balances | {{JournalPosted}} |
| **Merchant Onboarding** (supporting) | merchant, KYB, pricing plan | {{MerchantActivated}} |

### Flow
Authorisation decides in milliseconds; Payment lifecycle owns the merchant-facing state machine; Settlement reconciles scheme files against captures; Funding nets settled amounts minus fees and reserves into payouts; every money movement becomes ledger journals; Disputes reverse money through the ledger and adjust funding.

### Design points
- **Money invariants** in the Ledger and Funding (cannot pay out more than settled minus reserves).
- Authorisation has strict latency: small model, in-memory risk features, no synchronous calls to slow contexts.
- Scheme specifics (Visa/Mastercard formats) behind **ACLs** in Settlement and Disputes.
- Idempotency everywhere (scheme messages repeat); reconciliation between contexts as a first-class process.`,
  dia: r`flowchart LR
  AU[Authorisation] -->|PaymentAuthorised| PL[Payment lifecycle]
  PL -->|PaymentCaptured| CS[Clearing and Settlement]
  CS -->|TransactionSettled| MF[Merchant Funding]
  CS -->|journal requests| LG[Ledger]
  MF -->|PayoutSent| LG
  DS[Disputes] -->|ChargebackReceived| MF
  DS -->|journal requests| LG
  SCH[Card schemes] -->|ACL| CS
  SCH -->|ACL| DS
  ON[Merchant Onboarding] -->|MerchantActivated, pricing| MF`,
  code: r`~~~csharp
// Merchant Funding: cannot pay out more than settled minus reserve
public sealed class MerchantBalance : AggregateRoot<MerchantId>
{
    public Money Settled { get; private set; }
    public Money Reserve { get; private set; }
    public Money PaidOut { get; private set; }

    public void RecordSettlement(Money net) { Settled = Settled.Add(net); Touch(); }
    public void ApplyChargeback(Money amount) { Settled = Settled.Subtract(amount); Raise(new ChargebackDebited(Id, amount)); }

    public Payout SchedulePayout(DateOnly on)
    {
        var available = Settled.Subtract(Reserve).Subtract(PaidOut);
        if (available <= Money.Zero(available.Currency)) throw new DomainException("Nothing available to pay out");
        PaidOut = PaidOut.Add(available);
        Raise(new PayoutScheduled(Id, available, on));
        return new Payout(PayoutId.New(), Id, available, on);
    }
}

// Settlement ACL: scheme record -> our language
internal static SettledTransaction Translate(VisaBaseIIRecord r) =>
    new(new PaymentReference(r.AcquirerReferenceNumber), Money.FromMinorUnits(r.SourceAmount, Iso4217.FromNumeric(r.SourceCurrency)),
        Money.FromMinorUnits(r.InterchangeFee, Iso4217.FromNumeric(r.SettlementCurrency)), DateOnly.ParseExact(r.CentralProcessingDate, "yyMMdd"));
~~~`,
  pts: [r`Separate authorisation, lifecycle, settlement, funding, disputes and ledger.`, r`Each context has its own language and events.`, r`Money invariants in Ledger and Funding.`, r`Scheme formats behind ACLs; strict latency in authorisation.`, r`Idempotency and reconciliation between contexts as first-class processes.`],
  ex: r`An acquirer modelled payouts inside the payment service and paid merchants before settlement confirmed; a scheme file delay led to 3 million EUR paid out against transactions later charged back. A Funding context paying only settled-minus-reserve amounts made the exposure impossible.`,
  fu: [r`How do partial captures and refunds flow into settlement and funding?`, r`Where do interchange fees get calculated?`, r`How do you reconcile scheme files with captures?`],
  pit: [r`One giant Payment model for every stage.`, r`Paying out before settlement.`, r`Scheme formats leaking into core models.`] },

{ id: 'q46', level: 'Principal', tags: ['ddd', 'regulation', 'audit', 'explainability'],
  q: r`How do regulatory requirements (audit trails, explainable decisions, data retention, right to erasure, segregation of duties) shape a domain model in a bank? Give concrete modelling choices.`,
  a: r`### Requirements and modelling responses
| Requirement | Modelling choice |
|---|---|
| **Audit trail** of who changed what and why | domain events with actor, reason and correlation id on every command; temporal tables or event sourcing for regulated aggregates |
| **Explainable decisions** (credit, fraud, pricing) | decisions are first-class objects: {{CreditDecision}} with inputs snapshot, rule/model version, outcome and reasons codes; never just a boolean |
| **Reconstruction** ("what did we know when?") | bitemporal data: valid time modelled, system time recorded |
| **Retention** (7 to 10 years) | archive policies per aggregate; immutable records; retention tags in the model |
| **Erasure (GDPR)** vs retention | separate personal data from financial records; pseudonymise; crypto-shredding for event-sourced data |
| **Segregation of duties / four-eyes** | approvals modelled explicitly: a {{PendingChange}} aggregate requiring an approver different from the maker |
| **Regulatory reporting** | dedicated reporting context consuming events; no reporting logic inside core models |

### Principles
- Treat compliance as **domain**, not infrastructure: the regulator's language (maker-checker, override, reason code) appears in the model and tests.
- Make the **default** path compliant: commands cannot be executed without required actor and reason fields.
- Design for **evidence**: every important decision can be printed with its inputs and the rule version.`,
  code: r`~~~csharp
// Explainable decision as a first-class domain object
public sealed record CreditDecision(
    DecisionId Id, ApplicationId Application, DecisionOutcome Outcome, Money? ApprovedLimit,
    IReadOnlyList<ReasonCode> Reasons, string PolicyVersion, string ModelVersion,
    InputsSnapshot Inputs, DateTimeOffset DecidedAt, ActorRef DecidedBy);

// Maker-checker modelled explicitly
public sealed class LimitChangeRequest : AggregateRoot<ChangeRequestId>
{
    public UserId Maker { get; }
    public Money RequestedLimit { get; }
    public string Reason { get; }
    public ChangeStatus Status { get; private set; } = ChangeStatus.Pending;

    public void Approve(UserId checker, DateTimeOffset at)
    {
        if (checker == Maker) throw new SegregationOfDutiesViolation(Maker);
        if (Status != ChangeStatus.Pending) throw new DomainException("Already decided");
        Status = ChangeStatus.Approved;
        Raise(new LimitChangeApproved(Id, RequestedLimit, Maker, checker, Reason, at));    // applied by a policy
    }
}

// Personal data separated from financial records for erasure
public sealed class Customer { public PartyId Id { get; } public EncryptedPersonalData Personal { get; private set; } /* key per subject */ }
public sealed class Transaction { public PartyId Party { get; } public Money Amount { get; } /* no personal data; retained 10 years */ }
~~~`,
  pts: [r`Compliance concepts belong in the domain language.`, r`Decisions are objects with inputs, versions and reason codes.`, r`Maker-checker modelled as explicit approval aggregates.`, r`Separate personal data from retained financial records; crypto-shred where needed.`, r`Events with actor and reason give the audit trail by default.`],
  ex: r`A lender could not explain to the regulator why 1,200 applicants had been declined because the system stored only an approved/declined flag. Modelling CreditDecision with inputs, policy version and reason codes let the bank answer every subsequent complaint within a day.`,
  fu: [r`How do you reconcile GDPR erasure with 10-year retention?`, r`How do you version decision models for explainability?`, r`Where does the four-eyes rule live when the approval comes from another system?`],
  pit: [r`Audit as an afterthought in logs.`, r`Decisions stored as booleans.`, r`Personal data mixed into retained financial records.`] },

{ id: 'q47', level: 'Principal', tags: ['ddd', 'saas', 'vendor-integration', 'acl'],
  q: r`You adopt SaaS products for generic subdomains (Salesforce for CRM, Stripe for billing, a KYC vendor). How do you integrate them without letting their models leak into your core, and how do you keep the option to switch vendors?`,
  a: r`### Principles
- The vendor owns its **generic** model; your **core** contexts own theirs. Integration happens at explicit boundaries.
- **Ports in your language** ({{ISubscriptionBilling}}, {{IIdentityVerification}}) with vendor adapters behind them (ACLs).
- Vendor ids are **external references** stored on your aggregates, not your identities.

### Data flow
- Vendor → you: webhooks translated into **your** events ({{SubscriptionPaymentFailed}}) after verification (signature), deduplication and ordering checks.
- You → vendor: commands through the adapter, with idempotency keys, retries and reconciliation.
- **Source of truth** per attribute agreed explicitly (Salesforce for sales pipeline; your system for contract and money).

### Switching cost management
- Keep business rules out of vendor configuration where they are core (do not encode pricing logic in the billing vendor's rules if pricing is your differentiator).
- Export data regularly into your own store.
- Contract tests for adapters; a second adapter (or a fake) proves the port is not vendor-shaped.
- Accept some vendor features as conformist where switching is unlikely and the cost of abstraction is high: a deliberate, documented decision.

### Governance
Vendor reviews include data residency, outage behaviour, rate limits, webhook guarantees and exit plan.`,
  code: r`~~~csharp
// Port in our language
public interface ISubscriptionBilling
{
    Task<ExternalRef> StartAsync(AccountId account, PlanCode plan, Money price, CancellationToken ct);
    Task CancelAsync(ExternalRef subscription, CancellationReason reason, CancellationToken ct);
}

// Stripe adapter (ACL)
internal sealed class StripeSubscriptionBilling(SubscriptionService stripe) : ISubscriptionBilling
{
    public async Task<ExternalRef> StartAsync(AccountId account, PlanCode plan, Money price, CancellationToken ct)
    {
        var sub = await stripe.CreateAsync(new SubscriptionCreateOptions
        {
            Customer = await CustomerRefFor(account, ct),
            Items = [new() { Price = PriceMap.For(plan, price.Currency) }],
            Metadata = new() { ["accountId"] = account.Value.ToString() }
        }, new RequestOptions { IdempotencyKey = $"start-{account.Value}-{plan}" }, ct);
        return new ExternalRef("stripe", sub.Id);
    }
    public Task CancelAsync(ExternalRef s, CancellationReason r, CancellationToken ct) => stripe.CancelAsync(s.Value, cancellationToken: ct);
    private Task<string> CustomerRefFor(AccountId a, CancellationToken ct) => Task.FromResult(a.Value.ToString());
}

// Webhook -> our event, verified and deduplicated
app.MapPost("/webhooks/stripe", async (HttpRequest req, IInbox inbox, IOutbox outbox, CancellationToken ct) =>
{
    var evt = EventUtility.ConstructEvent(await new StreamReader(req.Body).ReadToEndAsync(ct), req.Headers["Stripe-Signature"], secret);
    if (!await inbox.TryRecordAsync(evt.Id, ct)) return Results.Ok();                            // duplicate
    if (evt.Type == "invoice.payment_failed")
        await outbox.AddAsync(new SubscriptionPaymentFailed(AccountIdFrom(evt), evt.Created), ct);  // our language
    return Results.Ok();
});
~~~`,
  pts: [r`Ports in your language, vendor adapters as ACLs.`, r`Vendor ids are external references, not identities.`, r`Webhooks verified, deduplicated and translated into your events.`, r`Keep core rules out of vendor configuration; export data; agree sources of truth.`, r`Conformist only by explicit decision; vendor reviews include exit plans.`],
  ex: r`A subscription business encoded its discount and pricing rules in its billing vendor's configuration; when it needed usage-based pricing the vendor did not support, migration took a year. Its second product kept pricing in an internal context and used the vendor only to collect money.`,
  fu: [r`How do you reconcile your state with the vendor's?`, r`When is being conformist to a vendor acceptable?`, r`How do you test vendor adapters?`],
  pit: [r`Vendor objects in domain code.`, r`Core rules configured inside vendors.`, r`Trusting webhooks without verification or deduplication.`] },

{ id: 'q48', level: 'Principal', tags: ['ddd', 'model-evolution', 'refactoring', 'breakthrough'],
  q: r`Two years in, the team discovers the model is wrong in an important way (a "breakthrough": what was modelled as one Order is really a Quote, a Contract and a Fulfilment). How do you evolve the model, the data and the published contracts without stopping the business?`,
  a: r`### Recognise the breakthrough
Signals: awkward workarounds, flags like {{IsQuote}}, constant special cases, experts using words the code lacks, bugs at state transitions. Evans calls the shift to a deeper model a **breakthrough**; it is worth the effort when it removes a class of complexity.

### Plan in stages
1. **Model it first** with experts: new aggregates ({{Quote}}, {{Contract}}, {{Fulfilment}}), their invariants and events; tests that express the new rules.
2. **Expand**: introduce the new model alongside the old, write to both (or derive the new from the old's events), keep reads on the old.
3. **Migrate data**: backfill new aggregates from historical records, with reconciliation reports; handle records that do not fit (manual review).
4. **Switch reads and commands** feature by feature behind flags.
5. **Contracts**: publish new integration events ({{QuoteAccepted}}, {{ContractSigned}}) alongside old {{OrderChanged}} via adapters; migrate consumers; deprecate.
6. **Contract**: remove the old model, flags and adapters.

### Keep the business running
- Every step backward compatible and reversible.
- Business sign-off on migrated data samples.
- Measure: defects in the area, lead time, number of special cases removed.

### Cultural point
Model refactoring is normal, not failure. Budget for it in core domains, and keep the code ready for it (good tests, encapsulated aggregates, contracts separate from domain types).`,
  code: r`~~~csharp
// New model beside the old one
public sealed class Quote : AggregateRoot<QuoteId>
{
    public ContractTerms ProposedTerms { get; private set; }
    public DateTimeOffset ValidUntil { get; private set; }
    public Contract Accept(SignatureRef signature, DateTimeOffset at)
    {
        if (at > ValidUntil) throw new DomainException("Quote expired");
        Raise(new QuoteAccepted(Id, signature, at));
        return Contract.From(this, signature, at);
    }
}

// Backfill with reconciliation: historical Orders -> Quotes/Contracts
await foreach (var old in legacyOrders.StreamAsync(ct))
{
    var result = OrderMigration.Translate(old);           // Quote only, Quote + Contract, or NeedsReview
    switch (result)
    {
        case Migrated m: db.Quotes.Add(m.Quote); if (m.Contract is not null) db.Contracts.Add(m.Contract); break;
        case NeedsReview r: db.MigrationExceptions.Add(new(old.Id, r.Reason)); break;
    }
    if (++count % 1_000 == 0) { await db.SaveChangesAsync(ct); db.ChangeTracker.Clear(); }
}

// Transitional contract adapter: old consumers keep receiving OrderChanged
public sealed class OrderChangedCompat : IEventHandler<QuoteAccepted>, IEventHandler<ContractSigned>
{
    public Task Handle(EventEnvelope<QuoteAccepted> e, CancellationToken ct) => outbox.AddAsync(OrderChangedV4.FromQuote(e.Data), ct);
    public Task Handle(EventEnvelope<ContractSigned> e, CancellationToken ct) => outbox.AddAsync(OrderChangedV4.FromContract(e.Data), ct);
}
~~~`,
  pts: [r`Recognise breakthroughs by workarounds, flags and missing expert terms.`, r`Model first with experts and tests.`, r`Expand, backfill with reconciliation, switch behind flags, contract.`, r`Publish new contracts alongside old via adapters, then deprecate.`, r`Budget for model refactoring in core domains.`],
  ex: r`An insurer's "Order" carried 19 flags distinguishing quotes, bound policies and renewals; most production bugs came from flag combinations. Splitting into Quote, Policy and Renewal aggregates over four releases removed 60% of the special-case code, with 0.3% of historical records needing manual review during migration.`,
  fu: [r`How do you migrate in-flight records that are halfway through a process?`, r`How do you convince the business to fund a model refactoring?`, r`How long do you keep the compatibility events?`],
  pit: [r`Living with flags forever.`, r`Big-bang data migration.`, r`Breaking consumers during the change.`] },

{ id: 'q49', level: 'Principal', tags: ['ddd', 'code-review', 'aggregates'],
  q: r`Code review: what is wrong with this "domain model" and handler, in DDD terms, and how would you fix it?`,
  a: r`~~~csharp
public class Account
{
    public Guid Id { get; set; }
    public decimal Balance { get; set; }
    public string Currency { get; set; }
    public string Status { get; set; }
    public Customer Customer { get; set; }                  // navigation to another aggregate
    public List<Transaction> Transactions { get; set; } = new();
}

public class TransferHandler(BankDbContext db, IEmailSender email, IBus bus)
{
    public async Task Handle(Guid from, Guid to, decimal amount)
    {
        var a = await db.Accounts.Include(x => x.Transactions).Include(x => x.Customer).FirstAsync(x => x.Id == from);
        var b = await db.Accounts.Include(x => x.Transactions).FirstAsync(x => x.Id == to);
        if (a.Status == "Active" && a.Balance >= amount)
        {
            a.Balance -= amount; b.Balance += amount;
            a.Transactions.Add(new Transaction { Amount = -amount });
            b.Transactions.Add(new Transaction { Amount = amount });
            await bus.Publish(new TransferDone(from, to, amount));
            await db.SaveChangesAsync();
            await email.SendAsync(a.Customer.Email, "Transfer done");
        }
    }
}
~~~

Findings:
1. **Anemic model with public setters**: rules (active status, sufficient funds) live in the handler; any code can set {{Balance}}.
2. **Primitive obsession**: {{decimal}} amount without currency; currencies of the two accounts never compared; {{string}} status.
3. **Two aggregates modified in one transaction**, both loaded with **all transactions** (huge, contended aggregates).
4. **Navigation to Customer** (another aggregate) and sending email from the handler: cross-context coupling.
5. **Publishing before commit**: the event can be published and the save fail (or the reverse if order flips): dual write. Use the outbox.
6. **No concurrency control**: two transfers can both pass the balance check (lost update).
7. **No idempotency**: a retried request transfers twice.
8. Silent no-op when the rule fails: the caller gets success.
9. Ledger semantics: balances mutated without a balanced journal.

### Fix
Small {{Account}} aggregate with {{Money}}, typed status and methods; a **Transfer** expressed as a balanced journal in the Ledger context (or a transfer process with debit then credit); outbox for events; notification by a separate context reacting to the event; rowversion and idempotency key.`,
  code: r`~~~csharp
public sealed class Account : AggregateRoot<AccountId>
{
    public Money Available { get; private set; }
    public AccountStatus Status { get; private set; }
    public void Debit(Money amount)
    {
        if (Status != AccountStatus.Active) throw new DomainException("account.not_active");
        if (amount.Currency != Available.Currency) throw new CurrencyMismatchException(Available.Currency, amount.Currency);
        if (Available < amount) throw new InsufficientFundsException(Id, amount);
        Available = Available.Subtract(amount); Touch();
    }
    public void Credit(Money amount) { /* same checks */ Available = Available.Add(amount); Touch(); }
}

public sealed class TransferHandler(IAccountRepository accounts, IJournalRepository journals, IUnitOfWork uow)
{
    public async Task<Result> Handle(Transfer cmd, CancellationToken ct)
    {
        if (await journals.ExistsAsync(new SourceReference("transfer", cmd.RequestId), ct)) return Result.AlreadyProcessed();
        var (first, second) = cmd.From.Value.CompareTo(cmd.To.Value) < 0 ? (cmd.From, cmd.To) : (cmd.To, cmd.From);   // lock order
        var a = await accounts.GetAsync(first, ct); var b = await accounts.GetAsync(second, ct);
        var (src, dst) = a.Id == cmd.From ? (a, b) : (b, a);
        src.Debit(cmd.Amount); dst.Credit(cmd.Amount);
        journals.Add(JournalEntry.Transfer(new SourceReference("transfer", cmd.RequestId), src.Id, dst.Id, cmd.Amount));
        await uow.SaveChangesAsync(ct);          // rowversions + TransferCompleted to outbox in the same transaction
        return Result.Ok();
    }
}
// Notifications context reacts to TransferCompleted and emails the customer.
~~~`,
  pts: [r`Anemic model with public setters puts rules in handlers.`, r`Primitive money and string statuses invite errors.`, r`Huge aggregates and navigations across aggregates.`, r`Publishing before commit is a dual write: use the outbox.`, r`Missing concurrency, idempotency and ledger semantics.`],
  ex: r`This pattern caused a real incident at a neobank: a retried transfer request moved money twice, and the "TransferDone" event was published for a transfer whose save later failed, confusing the mobile app. The redesign with an idempotent journal and outbox removed both failure classes.`,
  fu: [r`Is modifying two accounts in one transaction acceptable here?`, r`How would you model this transfer across two banks?`, r`What tests would you add first?`],
  pit: [r`Fixing only the public setters.`, r`Keeping the email in the handler.`, r`Ignoring the publish-before-commit bug.`] },

{ id: 'q50', level: 'Principal', tags: ['ddd', 'data-mesh', 'analytics', 'data-products'],
  q: r`How does DDD extend to analytics and data platforms? Discuss domain-owned data products (data mesh), using events vs CDC for analytical data, and how to avoid a central warehouse that recreates the canonical model problem.`,
  a: r`### The problem
A central data team ingests every service's tables into a warehouse and builds a canonical enterprise model. It couples analytics to internal schemas (every schema change breaks pipelines), the central team becomes a bottleneck, and the meaning of data is lost outside the owning context.

### Data mesh, in DDD terms
- **Domain ownership**: each bounded context owns its **analytical data products** as well as its operational model.
- **Data as a product**: published, documented, versioned, with SLAs, quality checks and owners, analogous to a published language.
- **Self-serve platform**: a platform team provides storage, pipelines, catalogue, access control.
- **Federated governance**: global standards (identifiers, privacy classification, formats) with local autonomy.

### Sources for data products
- **Integration events** (published language): stable, business-meaningful; best for facts like {{PaymentCaptured}}.
- **CDC on internal tables**: complete but couples consumers to internal schemas; acceptable only **inside** the owning team's pipeline, which then publishes a stable product.
- **Outbox-based** event streams to the lakehouse.

### Cross-domain analytics
Joins across products on **global ids** (customer, account) and shared reference data (calendars, currencies); conformed dimensions are agreed minimal standards, not a canonical model.

### Practical guardrails
Schema contracts and compatibility checks for data products, data quality tests, PII classification and masking, lineage, and cost ownership per domain.`,
  dia: r`flowchart LR
  P[Payments context] -->|outbox events| PP[Payments data product: captured, refunded]
  L[Ledger context] -->|journal events| LP[Ledger data product: postings, balances daily]
  C[Customer context] -->|CDC inside team pipeline| CP[Customer data product: profile v2]
  PP --> LH[(Lakehouse on self-serve platform)]
  LP --> LH
  CP --> LH
  LH --> AN[Cross-domain analytics joined on global ids]`,
  code: r`~~~yaml
# Data product contract published by the Payments team
name: payments.captured_transactions
owner: team-payments
version: 2
grain: one row per capture
freshness_slo: 15 minutes
source: outbox topic payments.captured.v2
schema:
  - { name: payment_id,  type: string, pii: false }
  - { name: merchant_id, type: string, pii: false }
  - { name: customer_id, type: string, pii: pseudonymised }
  - { name: amount,      type: decimal(19,4) }
  - { name: currency,    type: string }
  - { name: captured_at, type: timestamp_utc }
quality_checks:
  - amount > 0
  - currency in iso4217
  - count(payment_id) == count(distinct payment_id)
~~~
~~~csharp
// The same published integration event feeds operational consumers and the data product
outbox.Add(new PaymentCapturedV2(p.Id.Value, p.MerchantId.Value, Pseudonym.For(p.CustomerId), p.Amount.Amount, p.Amount.Currency, at));
~~~`,
  pts: [r`Central warehouses on internal tables recreate canonical-model coupling.`, r`Contexts own analytical data products with contracts, SLAs and owners.`, r`Prefer integration events; CDC only inside the owning team's pipeline.`, r`Join across products on global ids and minimal conformed dimensions.`, r`Self-serve platform plus federated governance for privacy and quality.`],
  ex: r`A bank's central warehouse broke on average twice a week because services changed internal tables; analysts distrusted every dashboard. Moving to domain-owned data products fed by outbox events cut pipeline breakages by 90% and gave every metric an accountable owner.`,
  fu: [r`Who pays for data products, and how?`, r`How do you handle historical backfills for a new data product?`, r`How do you enforce PII rules across domains?`],
  pit: [r`CDC of internal tables consumed directly by analysts.`, r`A central team owning everyone's data semantics.`, r`Data products without contracts or quality checks.`] }
],
cheat: r`### Strategic first
Subdomains (problem space): core = build and invest, supporting = simple, generic = buy. Bounded context (solution space) = boundary of one consistent model and language; owns its data, language, contracts; ideally one team. Context ≠ microservice (deployment) ≠ module. Discover with Event Storming: pivotal events + language shifts = boundaries; hot spots = backlog.

### Context map
| Pattern | Use |
|---|---|
| OHS + Published Language | one upstream, many consumers; versioned events/APIs |
| Customer–Supplier | downstream has influence on upstream planning |
| Conformist | accept upstream model (reference data, some vendors) |
| ACL | legacy, vendors, models that would distort yours |
| Shared Kernel | tiny stable types only (Money), named owners |
| Separate Ways | duplication cheaper than coupling |

### Tactical building blocks
| Block | Rule |
|---|---|
| Entity | identity over time |
| Value object | immutable, equality by value, self-validating (records) |
| Aggregate | consistency boundary = the invariant; root only entry; small; refer by id; one per transaction |
| Domain service | stateless domain logic across aggregates, no I/O |
| Application service | orchestration, transactions, authorization; no business rules |
| Repository | per aggregate root, whole aggregates; no generic IRepository; queries bypass it |
| Domain event | internal fact, raised by aggregates |
| Integration event | versioned public contract via outbox |
| Factory / Specification / Policy | named creation / reusable predicate / varying rule |

### Consistency
Inside aggregate: immediate (rowversion on root, bump on child changes). Across aggregates/contexts: events, policies, process managers, sagas with business compensations and timeouts. Hard cross-context invariant: one authoritative context, reserve at decision time (or headroom leases); fail closed by decision. Idempotency (inbox, natural), per-aggregate versions for ordering.

### Persistence with EF Core
One DbContext + schema per context. Private setters, private ctor, field-mapped collections, complex/owned types for VOs, converters for typed ids, Ignore(DomainEvents), interceptor: domain events → outbox in same SaveChanges. No cross-aggregate navigations, no lazy loading.

### Data between contexts
Value as of a moment → copy into your aggregate. Current data for display → local replica from events (versioned) or query. Authoritative decision → ask the owner. Never share tables.

### Smells
Entity services (CustomerService, AccountService) = distributed monolith. Canonical enterprise model. Huge aggregates (wallet with all transactions). Anemic models with rules in handlers. Primitive obsession. Publishing before commit. Domain events as public contracts. Flags like IsQuote (missed concept).

### Principal moves
Change-coupling analysis to redraw boundaries; merge what changes together, split on language conflicts. Living context map + fitness functions + ADRs. Ledger as the single money authority. Decisions as explainable objects (inputs, versions, reason codes); maker-checker modelled. SaaS behind ports and ACLs. Data products per domain, joined on global ids.`
});
})(String.raw);
