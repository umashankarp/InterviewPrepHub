(function (r) {
registerTopic('32-clean-architecture', {
related: ['33-hexagonal-architecture', '31-domain-driven-design', '10-solid'],
questions: [
{ id: 'q1', level: 'Basic', tags: ['clean-architecture', 'rings', 'fundamentals'],
  q: r`What problem does Clean Architecture solve, what is in each ring, and what does "independent of frameworks, UI and database" actually buy you?`,
  a: r`Robert C. Martin's synthesis of Hexagonal and Onion ideas: **business rules at the centre**, independent of delivery mechanisms and infrastructure.

| Ring (inside → out) | Contains | Knows about |
|---|---|---|
| **Entities / Domain** | aggregates, value objects, invariants, domain services | nothing outside itself |
| **Use cases / Application** | one class per operation (CreatePayment), ports (repository, gateway, clock interfaces), application DTOs | Domain |
| **Interface adapters** | endpoints/controllers, presenters, repository and gateway implementations, mappers | Application, Domain |
| **Frameworks & drivers** | ASP.NET Core, EF Core, Kafka, HTTP clients, UI | everything (outermost) |

### What it buys
- **Testability**: business rules and use cases run in fast unit tests without a database, web server or broker.
- **Replaceability of details**: a new database, broker or delivery mechanism (HTTP, gRPC, queue consumer, CLI) touches adapters, not rules.
- **Screaming architecture**: the solution reveals use cases (CapturePayment, IssueRefund), not technologies.
- **Deferred decisions**: you can build and test rules before choosing storage.

### What it does not buy
Free performance, fewer bugs by itself, or value for CRUD apps with little logic. It is a cost paid for long-lived, rule-heavy systems.`,
  dia: r`flowchart LR
  FW[Frameworks and drivers: ASP.NET Core, EF Core, Kafka] --> IA[Interface adapters: endpoints, repositories, gateways]
  IA --> UC[Use cases: handlers and ports]
  UC --> EN[Entities: domain model]`,
  code: r`~~~text
src/
  Payments.Domain/          Payment, Money, PaymentStatus, DomainException          (references nothing)
  Payments.Application/     CapturePayment, IPaymentRepository, IPaymentGateway       (-> Domain)
  Payments.Infrastructure/  PaymentsDbContext, PaymentRepository, StripeGateway       (-> Application)
  Payments.Api/             endpoints, auth, Program.cs (composition root)            (-> Application, Infrastructure)
~~~
~~~csharp
// Use case: reads like the business operation, no framework types
public sealed class CapturePaymentHandler(IPaymentRepository payments, IPaymentGateway gateway, IUnitOfWork uow)
{
    public async Task<Result> Handle(CapturePayment cmd, CancellationToken ct)
    {
        var payment = await payments.GetAsync(cmd.PaymentId, ct);
        if (payment is null) return Result.NotFound();
        var ack = await gateway.CaptureAsync(payment.GatewayRef, cmd.Amount, ct);   // port, implemented outside
        payment.Capture(cmd.Amount, ack.Reference);                                  // rule in the domain
        await uow.SaveChangesAsync(ct);
        return Result.Ok();
    }
}
~~~`,
  pts: [r`Business rules at the centre, independent of frameworks and infrastructure.`, r`Rings: entities, use cases, interface adapters, frameworks.`, r`Buys testability, replaceable details and use-case-centric structure.`, r`Does not buy anything for CRUD apps with little logic.`, r`A cost justified by long-lived, rule-heavy systems.`],
  ex: r`A settlement service built with rules inside stored procedures and WCF services needed a full regression cycle of three weeks for every change. After moving rules into a domain core with use cases tested in milliseconds, the same changes shipped with a two-day cycle.`,
  fu: [r`What is "screaming architecture"?`, r`Is the database really a detail in a banking system?`, r`How does Clean Architecture relate to SOLID?`],
  pit: [r`Treating it as a folder template.`, r`Applying it to every service regardless of complexity.`, r`Framework types in inner rings.`] },

{ id: 'q2', level: 'Basic', tags: ['clean-architecture', 'dependency-rule', 'dip'],
  q: r`Explain the Dependency Rule. If a use case must call the database and an external API, how can source dependencies still point inward? Distinguish control flow from dependency direction.`,
  a: r`### The rule
**Source-code dependencies point only inward.** Nothing in an inner ring names anything in an outer ring: no {{using Microsoft.EntityFrameworkCore}} in Domain, no {{HttpContext}} in Application, no reference to a Stripe SDK type in a use case.

### Control flow vs dependency
At runtime, control flows **outward**: endpoint → use case → repository → SQL. The **source dependency** is inverted with the **Dependency Inversion Principle**:
1. The use case (inner) **owns an interface** describing what it needs: {{IPaymentRepository}}, {{IPaymentGateway}} (a **port**).
2. Infrastructure (outer) **implements** it (an **adapter**) and therefore depends inward.
3. The **composition root** (outermost) wires the implementation into the interface via DI.

### Why ownership matters
The interface must be shaped by the **inner ring's needs**, in its language ({{CaptureAsync(gatewayRef, amount)}}), not by the external system's API. If the port mirrors Stripe's SDK, the dependency is inverted in name only.

### In .NET it is a compile-time fact
Project references go one way: Domain ← Application ← Infrastructure ← Api. A wrong-direction reference is a compile error (a cycle). Architecture tests catch NuGet-level leaks (EF Core referenced from Application).`,
  dia: r`flowchart LR
  API[Api: endpoint] -->|calls| UC[Application: CapturePaymentHandler]
  UC -->|calls via interface| P((IPaymentGateway port))
  AD[Infrastructure: StripeGateway] -.->|implements| P
  AD -->|depends on| UC
  AD --> EXT[Stripe API]`,
  code: r`~~~csharp
// Application owns the port, in its own language
namespace Payments.Application.Ports;
public interface IPaymentGateway
{
    Task<CaptureAck> CaptureAsync(GatewayReference reference, Money amount, CancellationToken ct);
}

// Infrastructure implements it: the dependency points inward
namespace Payments.Infrastructure.Stripe;
internal sealed class StripeGateway(PaymentIntentService stripe) : IPaymentGateway
{
    public async Task<CaptureAck> CaptureAsync(GatewayReference r, Money amount, CancellationToken ct)
    {
        var intent = await stripe.CaptureAsync(r.Value, new() { AmountToCapture = amount.ToMinorUnits() }, cancellationToken: ct);
        return new CaptureAck(intent.LatestChargeId);
    }
}

// Composition root wires port to adapter
builder.Services.AddScoped<IPaymentGateway, StripeGateway>();

// Payments.Application.csproj: only an inward reference
// <ProjectReference Include="..\Payments.Domain\Payments.Domain.csproj" />
~~~`,
  pts: [r`Source dependencies point inward only.`, r`Control flows outward at runtime; DIP inverts the source dependency.`, r`Inner rings own ports shaped by their needs.`, r`Infrastructure implements ports; the composition root wires them.`, r`Project references make the rule a compile-time fact.`],
  ex: r`A team "inverted" dependencies with an IStripeClient interface mirroring Stripe's SDK; when they added Adyen, every use case changed because the port spoke Stripe's language. Redesigning the port around the application's needs made the second provider a new adapter only.`,
  fu: [r`What is the difference between DIP and DI?`, r`Who should own a port shared by two use cases?`, r`How do you detect ports that mirror vendor APIs?`],
  pit: [r`Ports that mirror external APIs.`, r`Application referencing Infrastructure "just for one type".`, r`Domain referencing EF Core for attributes.`] },

{ id: 'q3', level: 'Basic', tags: ['clean-architecture', 'boundaries', 'dtos', 'mapping'],
  q: r`What is allowed to cross ring boundaries (DTOs, commands, results, interfaces, domain objects), and where does mapping happen?`,
  a: r`### What crosses
- **Inward**: simple data structures (commands, queries, request models) and calls through interfaces the inner ring owns.
- **Outward**: results (response models, Result types), domain events, and calls on ports.
- **Never inward**: framework types ({{HttpRequest}}, {{ClaimsPrincipal}} raw, {{DbContext}}, {{IQueryable}} from EF, Kafka {{ConsumeResult}}, vendor SDK types).

### Mapping points
| Boundary | Mapping |
|---|---|
| HTTP → use case | endpoint maps request DTO to command (and validates format) |
| Use case → HTTP | endpoint maps result to response DTO / ProblemDetails |
| Use case ↔ persistence | usually none: EF maps domain objects directly via configuration in Infrastructure; a separate persistence model only for legacy or very different shapes |
| Use case ↔ external API | adapter maps port types to vendor types |
| Message → use case | consumer adapter maps the message contract to a command |

### Should domain objects leave the application ring?
Returning domain entities to endpoints couples the API contract to the domain model (renaming a property breaks clients; internal state leaks). Return **response models** from use cases, or project read models directly in queries.

### Cost
Mapping is code to write and maintain; allocate it where it protects something (public contracts, vendor isolation), not as pass-through layers between identical shapes.`,
  code: r`~~~csharp
// HTTP request DTO (Api ring) -> command (Application ring)
public sealed record CapturePaymentRequest(decimal Amount, string Currency);
public sealed record CapturePayment(PaymentId PaymentId, Money Amount);          // application command
public sealed record CaptureResult(Guid PaymentId, string Status, decimal Captured); // response model, not the entity

app.MapPost("/payments/{id:guid}/capture", async (Guid id, CapturePaymentRequest req, CapturePaymentHandler h, CancellationToken ct) =>
{
    var result = await h.Handle(new CapturePayment(new PaymentId(id), new Money(req.Amount, req.Currency)), ct);
    return result.Match(ok => Results.Ok(ok), err => err.ToProblem());
});

// Message consumer (primary adapter) maps the contract to the same command
public sealed class CaptureRequestedConsumer(CapturePaymentHandler h) : IConsumer<CaptureRequestedV1>
{
    public Task Consume(ConsumeContext<CaptureRequestedV1> ctx) =>
        h.Handle(new CapturePayment(new PaymentId(ctx.Message.PaymentId), new Money(ctx.Message.Amount, ctx.Message.Currency)), ctx.CancellationToken);
}

// Never: public Task Handle(HttpRequest request) in Application
~~~`,
  pts: [r`Only simple data structures and inner-owned interfaces cross boundaries.`, r`No framework, ORM or vendor types inward.`, r`Map at adapters: HTTP, messages, vendors.`, r`Return response models, not entities, to delivery mechanisms.`, r`Map only where it protects something; avoid pass-through layers.`],
  ex: r`An API returned EF entities directly; adding an internal RiskScore property to Customer exposed it to every mobile client, which a security review flagged. Response models per use case stopped internal fields leaking.`,
  fu: [r`Is it acceptable for queries to return DTOs projected directly by EF?`, r`Where do you convert ClaimsPrincipal into something the application understands?`, r`How do you avoid four layers of identical DTOs?`],
  pit: [r`HttpContext or DbContext in use cases.`, r`Entities serialised as API contracts.`, r`Mapping layers between identical shapes.`] },

{ id: 'q4', level: 'Basic', tags: ['clean-architecture', 'solution-layout', 'composition-root', 'di'],
  q: r`Lay out a Clean Architecture solution in .NET: projects, references, DI registration per project, and why the composition root lives in the outermost project.`,
  a: r`### Projects and references
| Project | References | Contains |
|---|---|---|
| {{Domain}} | nothing (maybe tiny primitives package) | entities, value objects, domain events, domain services |
| {{Application}} | Domain | use cases, ports, validators, application DTOs, {{AddApplication()}} |
| {{Infrastructure}} | Application (and Domain transitively) | EF Core, repositories, gateways, outbox, messaging, {{AddInfrastructure()}} |
| {{Api}} (host) | Application, Infrastructure | endpoints, auth, middleware, {{Program.cs}} |
| tests | per ring | unit, integration, architecture tests |

### Composition root
The **only** place that knows all concrete types: it calls {{AddApplication()}} and {{AddInfrastructure(config)}} and registers hosting concerns. Inner projects expose registration extension methods but never decide which adapter is used in which environment.

### Why the host references Infrastructure
Only to wire it. Endpoints should depend on Application types; an architecture test can forbid Api code (other than Program/DI) from using Infrastructure namespaces.

### Visibility
Make adapters {{internal}} so only the registration method exposes them; this stops endpoints from newing up repositories directly.

### Keep it proportionate
Four projects is the common maximum for one service. Extra projects (Contracts for published events, a Shared kernel) need a reason.`,
  code: r`~~~csharp
// Payments.Application/DependencyInjection.cs
public static class ApplicationRegistration
{
    public static IServiceCollection AddApplication(this IServiceCollection s)
    {
        s.AddScoped<CapturePaymentHandler>();
        s.AddScoped<RefundPaymentHandler>();
        s.AddValidatorsFromAssembly(typeof(ApplicationRegistration).Assembly, includeInternalTypes: true);
        return s;
    }
}

// Payments.Infrastructure/DependencyInjection.cs
public static class InfrastructureRegistration
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection s, IConfiguration cfg)
    {
        s.AddDbContext<PaymentsDbContext>(o => o.UseSqlServer(cfg.GetConnectionString("Payments")));
        s.AddScoped<IPaymentRepository, PaymentRepository>();                  // internal class
        s.AddScoped<IUnitOfWork>(sp => sp.GetRequiredService<PaymentsDbContext>());
        s.AddHttpClient<IPaymentGateway, StripeGateway>().AddStandardResilienceHandler();
        s.AddSingleton(TimeProvider.System);
        return s;
    }
}

// Payments.Api/Program.cs: composition root
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddApplication();
builder.Services.AddInfrastructure(builder.Configuration);
builder.Host.UseDefaultServiceProvider(o => { o.ValidateScopes = true; o.ValidateOnBuild = true; });
var app = builder.Build();
app.MapPaymentEndpoints();
app.Run();
~~~`,
  pts: [r`Domain ← Application ← Infrastructure ← Api, one-way references.`, r`Each ring exposes a registration extension; the host composes.`, r`The composition root alone knows concrete types.`, r`Adapters internal; architecture tests stop endpoints using Infrastructure.`, r`Keep the project count proportionate.`],
  ex: r`A team's controllers instantiated SqlConnections and repositories directly despite the layered projects, because Infrastructure types were public. Making adapters internal and adding one architecture test removed 60 direct infrastructure uses in a sprint.`,
  fu: [r`Should Application reference Microsoft.Extensions.DependencyInjection?`, r`Where do hosted background services get registered?`, r`How do you share registration between the API and a worker host?`],
  pit: [r`Public adapter classes.`, r`Composition logic inside inner rings.`, r`Ten projects for one small service.`] },

{ id: 'q5', level: 'Basic', tags: ['clean-architecture', 'use-cases', 'application-layer'],
  q: r`What exactly is a use case in Clean Architecture? What belongs in it vs the domain vs the endpoint, and what does a good use case look like?`,
  a: r`A **use case** (interactor) is one application operation expressed in business terms: {{CapturePayment}}, {{OpenAccount}}, {{ScheduleRepayment}}. It is the **application's API**, independent of delivery (HTTP, queue, CLI, test).

### Responsibilities
| Endpoint / adapter | Use case | Domain |
|---|---|---|
| transport: parse, authenticate, format validation, map to command, map result to HTTP | **orchestrate**: authorise the action, load aggregates through ports, call domain behaviour, call external ports, persist via unit of work, emit events, return a result | **decide**: invariants, state transitions, calculations |

### A good use case
- Short and readable top to bottom; one transaction; no business rules (no {{if (balance < amount)}}).
- Named in the ubiquitous language.
- Depends only on ports and the domain.
- Returns a result describing the outcome (success, not found, rule violation) rather than HTTP concepts.
- Testable with fakes for every port.

### Smells
- 300-line handlers with business conditions (anemic domain).
- Use cases calling other use cases in chains (hidden coupling; extract a domain service or a process instead).
- Generic "service" classes with 40 methods instead of one use case per operation.`,
  code: r`~~~csharp
public sealed record IssueRefund(PaymentId PaymentId, Money Amount, RefundReason Reason, UserId RequestedBy);

public sealed class IssueRefundHandler(
    IPaymentRepository payments, IRefundGateway gateway, IAuthorizationPolicy authz, IUnitOfWork uow, TimeProvider clock)
{
    public async Task<Result<RefundResult>> Handle(IssueRefund cmd, CancellationToken ct)
    {
        var payment = await payments.GetAsync(cmd.PaymentId, ct);
        if (payment is null) return Result.NotFound<RefundResult>("payment.not_found");
        if (!await authz.CanRefundAsync(cmd.RequestedBy, payment.MerchantId, ct)) return Result.Forbidden<RefundResult>();

        var refund = payment.Refund(cmd.Amount, cmd.Reason, clock.GetUtcNow());     // domain decides
        var ack = await gateway.RefundAsync(payment.GatewayRef, cmd.Amount, refund.Id, ct);
        refund.Confirm(ack.Reference);

        await uow.SaveChangesAsync(ct);                                             // one transaction, events to outbox
        return Result.Ok(new RefundResult(refund.Id.Value, refund.Status.ToString()));
    }
}
~~~`,
  pts: [r`Use case = one application operation, delivery-independent.`, r`Orchestrates: authorise, load, call domain, call ports, persist, emit.`, r`No business rules; the domain decides.`, r`Returns outcome results, not HTTP concepts.`, r`One per operation; avoid use cases calling use cases.`],
  ex: r`A PaymentService class with 38 methods had become the place every developer edited, with merge conflicts daily. Splitting it into one handler per use case cut conflicts and made each operation's dependencies explicit, revealing two methods nobody called.`,
  fu: [r`Can a use case call another use case?`, r`Where does an external call that must not be inside the transaction go?`, r`How do you share orchestration logic between use cases?`],
  pit: [r`Business rules in handlers.`, r`God service classes.`, r`HTTP status codes in the application layer.`] },

{ id: 'q6', level: 'Basic', tags: ['clean-architecture', 'solid', 'design-principles'],
  q: r`How do SRP, OCP, LSP, ISP and DIP show up concretely in a Clean Architecture codebase, especially at ring boundaries?`,
  a: r`| Principle | At the boundaries |
|---|---|
| **SRP** (one reason to change, one actor) | use cases split per operation; domain changes for business reasons, adapters for technical reasons; a change in the database never edits a business rule |
| **OCP** (extend without modifying) | new delivery mechanisms (gRPC, a consumer) or providers (a second PSP adapter) are added as new adapters without editing use cases; new pricing rules as new policy implementations |
| **LSP** (substitutable implementations) | every adapter honours the **port contract**: a fake and the real repository behave the same (contract tests); an adapter that throws on methods it "does not support" violates LSP |
| **ISP** (small client-specific interfaces) | ports per need ({{IPaymentReader}}, {{IPaymentWriter}}, {{IRefundGateway}}) rather than one giant {{IPaymentService}}; use cases depend only on what they use |
| **DIP** (depend on abstractions owned by policy) | ports owned by the application, implemented by infrastructure: the core of the Dependency Rule |

### The crucial nuance
DIP is about **ownership**: the high-level policy owns the abstraction. Interfaces for everything (including pure domain classes) do not apply DIP; they add indirection. Abstract **volatile, external** dependencies (database, clock, network, vendors), not stable internal logic.`,
  code: r`~~~csharp
// ISP: small ports per need
public interface IPaymentReader { Task<Payment?> GetAsync(PaymentId id, CancellationToken ct); }
public interface IPaymentWriter { void Add(Payment p); }
public interface IRefundGateway { Task<RefundAck> RefundAsync(GatewayReference r, Money amount, RefundId id, CancellationToken ct); }

// OCP: a second provider is a new adapter, no use case edits
internal sealed class AdyenRefundGateway(AdyenClient c) : IRefundGateway { /* ... */ public Task<RefundAck> RefundAsync(GatewayReference r, Money a, RefundId id, CancellationToken ct) => throw new NotImplementedException(); }
internal sealed class RoutingRefundGateway(StripeRefundGateway stripe, AdyenRefundGateway adyen) : IRefundGateway
{
    public Task<RefundAck> RefundAsync(GatewayReference r, Money a, RefundId id, CancellationToken ct) =>
        r.Provider == "adyen" ? adyen.RefundAsync(r, a, id, ct) : stripe.RefundAsync(r, a, id, ct);
}

// LSP: one contract test suite for every implementation of the port
public abstract class PaymentRepositoryContract
{
    protected abstract (IPaymentReader, IPaymentWriter, IUnitOfWork) Create();
    [Fact] public async Task Saved_payment_can_be_read_back()
    {
        var (r, w, uow) = Create();
        var p = TestPayments.Authorised();
        w.Add(p); await uow.SaveChangesAsync(default);
        Assert.Equal(p.Id, (await r.GetAsync(p.Id, default))!.Id);
    }
}
public sealed class InMemoryRepositoryTests : PaymentRepositoryContract { protected override (IPaymentReader, IPaymentWriter, IUnitOfWork) Create() => InMemory.Create(); }
public sealed class SqlRepositoryTests : PaymentRepositoryContract { protected override (IPaymentReader, IPaymentWriter, IUnitOfWork) Create() => SqlFixture.Create(); }
~~~`,
  pts: [r`SRP: business and technical changes live in different places.`, r`OCP: new adapters and policies without editing use cases.`, r`LSP: adapters honour port contracts; prove with contract tests.`, r`ISP: small ports per need.`, r`DIP: the policy owns the abstraction; abstract volatile dependencies only.`],
  ex: r`A team's IPaymentService port had 22 methods; the test fake implemented 3 and threw on the rest, and a refactor that called a fourth method passed unit tests but failed in production paths. Splitting into focused ports with a shared contract suite caught such gaps in CI.`,
  fu: [r`When is an interface for a domain service unnecessary?`, r`How do you detect LSP violations in adapters?`, r`Is a generic repository an ISP violation?`],
  pit: [r`Interfaces for every class.`, r`Fat ports implemented partially.`, r`Fakes that behave differently from real adapters.`] },

{ id: 'q7', level: 'Intermediate', tags: ['clean-architecture', 'mediatr', 'handlers', 'licensing'],
  q: r`MediatR, Wolverine, source-generated Mediator or plain injected handlers: how do you implement use-case dispatch, and what are the trade-offs (indirection, pipelines, licensing, AOT)?`,
  a: r`### Options
| Approach | Pros | Cons |
|---|---|---|
| **Plain handlers** injected into endpoints | explicit, "go to definition" works, no library, AOT-friendly | cross-cutting concerns need decorators or explicit calls |
| **MediatR** | familiar, pipeline behaviours, notifications | indirection ({{Send}} hides the target), reflection-based registration, **commercial licence from v13 (2025)** |
| **Mediator** (source-generated) | MediatR-like API, compile-time dispatch, fast, AOT-friendly | another dependency |
| **Wolverine** | mediator + messaging + outbox + middleware in one | bigger framework commitment |

### What you really need
1. A way to invoke one use case per operation.
2. A place for **cross-cutting concerns**: validation, logging, transactions, idempotency, authorization.
Decorators (Scrutor {{Decorate}}) on handler interfaces provide (2) without a mediator.

### Decision guide
- Small or medium services: plain handlers + decorators; simplest to navigate.
- Many use cases with uniform pipelines: a mediator (prefer source-generated for performance/AOT, check licensing).
- Messaging-heavy services: a framework with outbox and handlers (Wolverine, MassTransit) can serve both.

Clean Architecture does **not** require a mediator; it requires use cases with inward dependencies.`,
  code: r`~~~csharp
// Plain handler interface + decorators (no mediator)
public interface IHandler<TCommand, TResult> { Task<TResult> Handle(TCommand command, CancellationToken ct); }

public sealed class LoggingDecorator<TC, TR>(IHandler<TC, TR> inner, ILogger<LoggingDecorator<TC, TR>> log) : IHandler<TC, TR>
{
    public async Task<TR> Handle(TC cmd, CancellationToken ct)
    {
        using var _ = log.BeginScope(new Dictionary<string, object> { ["UseCase"] = typeof(TC).Name });
        var sw = Stopwatch.StartNew();
        try { return await inner.Handle(cmd, ct); }
        finally { log.LogInformation("{UseCase} took {Ms} ms", typeof(TC).Name, sw.ElapsedMilliseconds); }
    }
}

builder.Services.Scan(s => s.FromAssemblyOf<CapturePaymentHandler>()
    .AddClasses(c => c.AssignableTo(typeof(IHandler<,>))).AsImplementedInterfaces().WithScopedLifetime());
builder.Services.Decorate(typeof(IHandler<,>), typeof(ValidationDecorator<,>));
builder.Services.Decorate(typeof(IHandler<,>), typeof(LoggingDecorator<,>));

// Endpoint depends on the specific handler: explicit, navigable
app.MapPost("/payments/{id:guid}/capture", (Guid id, CaptureRequest r, IHandler<CapturePayment, Result> h, CancellationToken ct)
    => h.Handle(new CapturePayment(new PaymentId(id), r.ToMoney()), ct));
~~~`,
  pts: [r`A mediator is optional; use cases are what matter.`, r`Plain handlers plus decorators give pipelines without indirection.`, r`MediatR became commercially licensed in 2025; source-generated alternatives exist.`, r`Choose by number of use cases, pipeline needs and messaging.`, r`Prefer AOT-friendly, navigable dispatch.`],
  ex: r`A team found that tracing a request through 9 MediatR behaviours and a notification fan-out took new joiners days; switching to explicit handlers with three decorators cut onboarding questions noticeably and removed a licence review from the backlog.`,
  fu: [r`How do you order decorators?`, r`What do MediatR notifications encourage that can be harmful?`, r`How do you make handler registration AOT-safe?`],
  pit: [r`Adopting a mediator by habit.`, r`Notifications as hidden coupling.`, r`Ignoring licensing changes.`] },

{ id: 'q8', level: 'Intermediate', tags: ['clean-architecture', 'pipeline-behaviors', 'cross-cutting', 'transactions'],
  q: r`Implement cross-cutting concerns as a use-case pipeline: validation, logging/tracing, transactions with outbox, idempotency and authorization. In what order, and what must not go in the pipeline?`,
  a: r`### Typical order (outer → inner)
1. **Logging / tracing** (Activity per use case, duration, outcome).
2. **Exception mapping** (unexpected → logged, rethrown or mapped at the edge).
3. **Authorization** for action-level permissions (resource-level checks often need loaded data, so they stay in the handler).
4. **Validation** (command format and simple rules) → fail fast before touching data.
5. **Idempotency** (seen this command id? return the stored result).
6. **Transaction / unit of work** wrapping the handler; commit includes outbox rows.
7. Handler.

### Rules
- Behaviours are **generic and mechanical**. Business rules never live there.
- Transactions only for commands, not queries (mark commands with an interface).
- Idempotency storage in the **same transaction** as the change.
- Keep the list short; each behaviour adds indirection and latency.

### What not to put in a pipeline
Business decisions, domain-specific branching ("if command is X then..."), long-running I/O like external calls inside the transaction behaviour, or caching of commands.`,
  code: r`~~~csharp
public interface ICommand<TResult> { Guid CommandId { get; } }

public sealed class IdempotencyDecorator<TC, TR>(IHandler<TC, TR> inner, IIdempotencyStore store) : IHandler<TC, TR> where TC : ICommand<TR>
{
    public async Task<TR> Handle(TC cmd, CancellationToken ct)
    {
        if (await store.TryGetAsync<TR>(cmd.CommandId, ct) is { } previous) return previous;
        var result = await inner.Handle(cmd, ct);
        store.Record(cmd.CommandId, result);              // saved by the transaction decorator below, atomically
        return result;
    }
}

public sealed class TransactionDecorator<TC, TR>(IHandler<TC, TR> inner, IUnitOfWork uow) : IHandler<TC, TR> where TC : ICommand<TR>
{
    public async Task<TR> Handle(TC cmd, CancellationToken ct)
    {
        await using var tx = await uow.BeginAsync(ct);
        var result = await inner.Handle(cmd, ct);
        await uow.SaveChangesAsync(ct);                   // domain events -> outbox, idempotency record
        await tx.CommitAsync(ct);
        return result;
    }
}

public sealed class ValidationDecorator<TC, TR>(IHandler<TC, TR> inner, IEnumerable<IValidator<TC>> validators) : IHandler<TC, TR>
{
    public async Task<TR> Handle(TC cmd, CancellationToken ct)
    {
        var errors = (await Task.WhenAll(validators.Select(v => v.ValidateAsync(cmd, ct)))).SelectMany(r => r.Errors).ToList();
        if (errors.Count > 0) throw new CommandValidationException(errors);
        return await inner.Handle(cmd, ct);
    }
}

// Registration order: last decorated = outermost
builder.Services.Decorate(typeof(IHandler<,>), typeof(TransactionDecorator<,>));
builder.Services.Decorate(typeof(IHandler<,>), typeof(IdempotencyDecorator<,>));
builder.Services.Decorate(typeof(IHandler<,>), typeof(ValidationDecorator<,>));
builder.Services.Decorate(typeof(IHandler<,>), typeof(LoggingDecorator<,>));
~~~`,
  pts: [r`Order: logging, exception handling, authorization, validation, idempotency, transaction, handler.`, r`Behaviours are mechanical; no business rules.`, r`Transactions and idempotency for commands only, in the same commit.`, r`No external I/O inside the transaction behaviour.`, r`Keep the pipeline short.`],
  ex: r`A transaction behaviour wrapped every request including queries and a slow external KYC call; under load, long transactions blocked writes on hot tables. Restricting it to commands and moving the KYC call before the transaction cut lock waits by 90%.`,
  fu: [r`Where do resource-level authorization checks go?`, r`How do you make idempotency safe under concurrent duplicates?`, r`How do you trace each use case in OpenTelemetry?`],
  pit: [r`Business logic in behaviours.`, r`Transactions around queries and external calls.`, r`Idempotency records saved outside the transaction.`] },

{ id: 'q9', level: 'Intermediate', tags: ['clean-architecture', 'architecture-tests', 'netarchtest', 'enforcement'],
  q: r`Project references already enforce direction. Why add architecture tests, which rules do you encode, and how do you keep them from becoming noise?`,
  a: r`### What references do not catch
- A NuGet package added to the wrong project (EF Core in Application, ASP.NET Core in Domain).
- Conventions: handlers sealed and named, entities without public setters, no {{DateTime.Now}} in Domain, adapters internal.
- Usage rules inside a project (endpoints using Infrastructure types directly in the Api project).
- Cross-module rules in a modular monolith.

### Rules worth encoding
1. Domain has no dependency on Application, Infrastructure, EF Core, ASP.NET Core, serializers.
2. Application has no dependency on Infrastructure or EF Core.
3. Api endpoints do not use Infrastructure namespaces (only Program/DI may).
4. Domain entities have no public setters.
5. Infrastructure adapter classes are internal and sealed.
6. Domain does not use {{DateTime.Now}}/{{UtcNow}} (use TimeProvider or pass time in).

### Keeping them useful
- Few, meaningful rules with clear failure messages explaining **why**.
- Run in CI as normal tests; fast.
- A shared test package across services for org-wide rules; service-specific rules locally.
- Baseline exceptions explicitly listed with owners and dates, never silently disabled.`,
  code: r`~~~csharp
public sealed class ArchitectureTests
{
    private static readonly Assembly Domain = typeof(Payments.Domain.Payment).Assembly;
    private static readonly Assembly Application = typeof(Payments.Application.CapturePayment).Assembly;
    private static readonly Assembly Api = typeof(Payments.Api.Program).Assembly;

    [Fact]
    public void Domain_is_framework_free() => AssertOk(Types.InAssembly(Domain).ShouldNot()
        .HaveDependencyOnAny("Payments.Application", "Payments.Infrastructure", "Microsoft.EntityFrameworkCore",
                             "Microsoft.AspNetCore", "System.Text.Json").GetResult(),
        "Domain must not depend on frameworks: rules must be testable and portable");

    [Fact]
    public void Endpoints_do_not_use_infrastructure() => AssertOk(Types.InAssembly(Api)
        .That().ResideInNamespace("Payments.Api.Endpoints")
        .ShouldNot().HaveDependencyOn("Payments.Infrastructure").GetResult(),
        "Endpoints call use cases; only the composition root wires infrastructure");

    [Fact]
    public void Entities_have_no_public_setters()
    {
        var offenders = Domain.GetTypes().Where(t => t.IsSubclassOfRawGeneric(typeof(AggregateRoot<>)))
            .SelectMany(t => t.GetProperties().Where(p => p.SetMethod?.IsPublic == true).Select(p => $"{t.Name}.{p.Name}"));
        Assert.Empty(offenders);
    }

    private static void AssertOk(TestResult r, string why) =>
        Assert.True(r.IsSuccessful, $"{why}. Offenders: {string.Join(", ", r.FailingTypeNames ?? [])}");
}
~~~`,
  pts: [r`References miss package leaks, conventions and intra-project usage.`, r`Encode a few meaningful rules with explanatory messages.`, r`Domain framework-free; Application free of Infrastructure; endpoints use use cases.`, r`Share org-wide rules as a package.`, r`Explicit, owned exceptions; never silent disabling.`],
  ex: r`An architecture test caught a developer adding Microsoft.EntityFrameworkCore to the Application project "for one Include"; the review would have missed it because the change was in the csproj. The fix moved the query into an Infrastructure query service.`,
  fu: [r`How do you introduce architecture tests into a codebase that already violates them?`, r`ArchUnitNET vs NetArchTest?`, r`Which rules belong in analyzers instead of tests?`],
  pit: [r`Dozens of brittle naming rules.`, r`Disabling failing tests.`, r`Relying only on code review for boundaries.`] },

{ id: 'q10', level: 'Intermediate', tags: ['clean-architecture', 'testing', 'contract-tests', 'testcontainers'],
  q: r`Design the testing strategy per ring in a Clean Architecture service: what is tested where, with what doubles, and how do you keep fakes honest?`,
  a: r`| Ring | Tests | Doubles |
|---|---|---|
| **Domain** | unit tests of invariants and behaviour, property-based tests | none |
| **Application** | use-case tests: outcomes, calls to ports, events | in-memory fakes for repositories, fake gateways, {{FakeTimeProvider}} |
| **Infrastructure** | integration tests of adapters against real SQL/brokers (Testcontainers), HTTP adapters against sandbox or WireMock | real dependencies or recorded contracts |
| **Api** | end-to-end through {{WebApplicationFactory}}: routing, auth, serialisation, ProblemDetails | real app, containers, fake external gateways |
| **Architecture** | dependency and convention rules | none |

### Keeping fakes honest
- **Port contract tests**: one abstract test suite run against both the fake and the real adapter; if the fake diverges, CI fails.
- Prefer **fakes** (working in-memory implementations) over mocks with call verification; mocks couple tests to implementation details.

### Proportions
Most tests at domain and application level (fast, many cases); fewer integration tests per adapter (mapping, queries, concurrency, transactions); a handful of end-to-end tests per critical flow.

### What teams get wrong
Testing use cases with mocked repositories that return whatever the test wants, so EF mapping and query bugs only show in production; or skipping domain tests and testing everything through HTTP (slow, brittle).`,
  code: r`~~~csharp
// Application test with fakes
[Fact]
public async Task Refund_is_rejected_when_amount_exceeds_captured()
{
    var payments = new InMemoryPaymentRepository();
    var payment = TestPayments.Captured(Money.Gbp(50)); payments.Add(payment);
    var gateway = new FakeRefundGateway();
    var handler = new IssueRefundHandler(payments, gateway, AllowAll.Policy, new FakeUnitOfWork(), new FakeTimeProvider());

    var result = await handler.Handle(new IssueRefund(payment.Id, Money.Gbp(60), RefundReason.CustomerRequest, TestUsers.Agent), default);

    Assert.Equal("refund.exceeds_captured", result.Error!.Code);
    Assert.Empty(gateway.Calls);                                  // no external call when the rule fails
}

// Adapter integration test against a real database
public sealed class PaymentRepositorySqlTests(SqlFixture db) : PaymentRepositoryContract, IClassFixture<SqlFixture>
{
    protected override (IPaymentReader, IPaymentWriter, IUnitOfWork) Create() => db.CreateRepository();
}

// Api test: routing, auth, ProblemDetails
[Fact]
public async Task Capture_returns_422_with_code_for_invalid_state()
{
    await using var app = new PaymentsApiFactory().WithFakeGateway();
    var client = app.CreateClient().WithMerchantToken();
    var resp = await client.PostAsJsonAsync($"/payments/{TestIds.VoidedPayment}/capture", new { amount = 10, currency = "GBP" });
    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    Assert.Equal("payment.capture.invalid_state", (await resp.Content.ReadFromJsonAsync<ProblemDetails>())!.Extensions["code"]!.ToString());
}
~~~`,
  pts: [r`Domain: pure unit tests; Application: fakes; Infrastructure: real dependencies; Api: WebApplicationFactory.`, r`Contract test suites keep fakes and real adapters aligned.`, r`Prefer fakes over call-verifying mocks.`, r`Many fast inner tests, fewer integration tests, a few end-to-end tests.`, r`Mapping and queries must be tested against the real database.`],
  ex: r`A service had 2,000 green unit tests with mocked repositories but failed in production on a mapping bug for a new value object. Adding repository contract tests run against SQL Server in Testcontainers caught the same class of bug the following month before merge.`,
  fu: [r`How do you test an HTTP adapter for a payment provider?`, r`When are mocks better than fakes?`, r`How do you keep integration tests fast?`],
  pit: [r`Mocked repositories as the only persistence tests.`, r`Everything tested through HTTP.`, r`Fakes that drift from real behaviour.`] },

{ id: 'q11', level: 'Intermediate', tags: ['clean-architecture', 'mapping', 'dtos', 'mapperly'],
  q: r`Mapping between DTOs, commands, domain objects and persistence: manual mapping vs AutoMapper vs Mapperly (source-generated). Where should each mapping live, and how do you avoid mapping layers that add nothing?`,
  a: r`### Where mapping belongs
- **Edge adapters** own the mapping between external contracts and the application (request DTO → command, result → response DTO). The application should not know HTTP DTOs.
- **Queries** can project straight from the database into response models (no domain objects involved).
- **Persistence**: EF Core maps domain objects via configuration; no mapping code unless a separate persistence model is justified.

### Tools
| Tool | Pros | Cons |
|---|---|---|
| **Manual** (constructors, static {{From}} methods, extension methods) | explicit, refactor-safe, fast, debuggable | boilerplate for large shapes |
| **AutoMapper** | less code for similar shapes; {{ProjectTo}} for queries | runtime reflection, silent mismatches, hidden logic in profiles; commercial licence from 2025 |
| **Mapperly** | source-generated: compile-time errors on unmapped members, fast, AOT-friendly | needs configuration for complex cases |

### Avoiding useless layers
If a request DTO, command, domain object and response DTO are all the same shape for a CRUD feature, the feature probably does not need Clean Architecture's full layering (use a vertical slice with direct EF). Keep mapping where shapes **differ** or contracts must be **stable**.

### Correctness
Unmapped or renamed fields are a common source of silent bugs: prefer compile-time-checked mapping and tests on critical mappings (money, ids, dates).`,
  code: r`~~~csharp
// Manual mapping at the edge: explicit and refactor-safe
public static class CaptureMapping
{
    public static CapturePayment ToCommand(this CapturePaymentRequest r, Guid id) => new(new PaymentId(id), new Money(r.Amount, r.Currency));
    public static CaptureResponse ToResponse(this CaptureResult r) => new(r.PaymentId, r.Status, r.Captured);
}

// Mapperly: generated at compile time; unmapped target members are build warnings/errors
[Mapper(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
public static partial class StatementMapper
{
    public static partial StatementLineDto ToDto(StatementLine line);
    private static decimal MoneyToDecimal(Money m) => m.Amount;     // custom conversion used by the generator
}

// Query: project straight to the response, no domain objects
public Task<List<StatementLineDto>> GetStatementAsync(AccountId id, CancellationToken ct) =>
    db.LedgerEntries.AsNoTracking().Where(e => e.AccountId == id)
      .OrderByDescending(e => e.BookedUtc).Take(100)
      .Select(e => new StatementLineDto(e.Id, e.BookedUtc, e.Amount.Amount, e.Amount.Currency, e.Description))
      .ToListAsync(ct);
~~~`,
  pts: [r`Edges map external contracts; application never sees HTTP DTOs.`, r`Queries project directly to response models.`, r`EF maps domain objects; separate persistence models only when needed.`, r`Prefer manual or source-generated mapping with compile-time checks.`, r`Identical shapes across layers signal unnecessary layering.`],
  ex: r`An AutoMapper profile silently left a new FeeAmount field unmapped on the merchant statement DTO; statements showed zero fees for two weeks. Switching critical mappings to Mapperly with required-target checks made such omissions build errors.`,
  fu: [r`Where do you map domain errors to ProblemDetails?`, r`Is AutoMapper ProjectTo acceptable for queries?`, r`How do you test mappings cheaply?`],
  pit: [r`Mapping layers between identical shapes.`, r`Business logic hidden in mapping profiles.`, r`Silent unmapped fields.`] },

{ id: 'q12', level: 'Intermediate', tags: ['clean-architecture', 'persistence', 'ef-core', 'unit-of-work'],
  q: r`Persistence in Clean Architecture with EF Core: repository and unit-of-work ports, where DbContext lives, whether EF entities are domain entities, and how queries access data.`,
  a: r`### Ports
- **Repository per aggregate** in Application ({{IPaymentRepository}}): {{GetAsync}}, {{Add}}.
- **Unit of work** port ({{IUnitOfWork.SaveChangesAsync}}): implemented by the DbContext.
- **Query ports** for read use cases when the application must not touch EF ({{IStatementQueries}}), implemented in Infrastructure with projections or Dapper.

### DbContext
Lives in **Infrastructure**; configuration via {{IEntityTypeConfiguration}} classes there. Domain classes carry no attributes.

### EF entities = domain entities?
Pragmatically **yes** for most .NET systems: EF Core maps private setters, backing fields, complex/owned types and converters, so one model works. Use a **separate persistence model** only for legacy schemas you cannot change or shapes EF cannot map well; it doubles mapping work.

### Queries
Reads do not need aggregates. Either:
- Application defines query ports, Infrastructure implements with EF projections/Dapper; or
- In a pragmatic variant, read-side handlers live in Infrastructure (or an Api "Queries" folder) and use the DbContext directly, while writes go through the domain.
Pick one convention per codebase.

### Transactions
One SaveChanges per use case; the outbox interceptor adds integration events in the same commit; explicit transactions (with execution strategy) only for multi-step units.`,
  code: r`~~~csharp
// Application ports
public interface IPaymentRepository { Task<Payment?> GetAsync(PaymentId id, CancellationToken ct); void Add(Payment p); }
public interface IUnitOfWork { Task<int> SaveChangesAsync(CancellationToken ct); }
public interface IMerchantStatementQueries { Task<IReadOnlyList<StatementLineDto>> ForMerchantAsync(MerchantId m, DateOnly from, CancellationToken ct); }

// Infrastructure: DbContext implements the unit of work
internal sealed class PaymentsDbContext(DbContextOptions<PaymentsDbContext> o) : DbContext(o), IUnitOfWork
{
    public DbSet<Payment> Payments => Set<Payment>();
    protected override void OnModelCreating(ModelBuilder mb) => mb.ApplyConfigurationsFromAssembly(typeof(PaymentsDbContext).Assembly);
}

// Query port implemented with Dapper for a heavy report
internal sealed class MerchantStatementQueries(PaymentsDbContext db) : IMerchantStatementQueries
{
    public async Task<IReadOnlyList<StatementLineDto>> ForMerchantAsync(MerchantId m, DateOnly from, CancellationToken ct)
    {
        var conn = db.Database.GetDbConnection();
        var rows = await conn.QueryAsync<StatementLineDto>(new CommandDefinition("""
            SELECT p.Id, p.CapturedUtc, p.Amount, p.Currency, p.Fee
            FROM payments.Payments p WHERE p.MerchantId = @m AND p.CapturedUtc >= @from ORDER BY p.CapturedUtc DESC
            """, new { m = m.Value, from = from.ToDateTime(TimeOnly.MinValue) }, cancellationToken: ct));
        return rows.AsList();
    }
}
~~~`,
  pts: [r`Repository per aggregate, unit-of-work and query ports in Application.`, r`DbContext and configurations in Infrastructure.`, r`One model mapped by EF in most cases; separate persistence model only when justified.`, r`Reads via query ports or a clear read-side convention.`, r`One SaveChanges per use case with the outbox in the same commit.`],
  ex: r`A team loaded aggregates through repositories to build reports, timing out at month-end. A query port implemented with Dapper and covering indexes returned the same report in 2 seconds without touching the domain model.`,
  fu: [r`Should IUnitOfWork expose transactions?`, r`Where do EF migrations live?`, r`How do you test query ports?`],
  pit: [r`DbContext in Application or Domain.`, r`Generic repositories exposing IQueryable.`, r`Reports through aggregate repositories.`] },

{ id: 'q13', level: 'Intermediate', tags: ['clean-architecture', 'errors', 'result-pattern', 'problem-details'],
  q: r`How do errors flow through the rings? Design a consistent approach from domain rule violations to HTTP ProblemDetails and to message consumers.`,
  a: r`### Error types by origin
- **Domain**: rule violations (insufficient funds, invalid transition) as Result failures or specific domain exceptions with stable codes.
- **Application**: not found, forbidden, validation failures, conflicts (concurrency), idempotent replays.
- **Infrastructure**: timeouts, unavailable dependencies, constraint violations (translated into application errors where meaningful, e.g. duplicate key → conflict).

### Flow
1. Domain returns or throws a domain error.
2. The use case returns {{Result<T>}} with an error (code, message, kind), or lets infrastructure exceptions propagate.
3. **Adapters translate**: HTTP endpoints map error kinds to status codes and ProblemDetails; message consumers decide ack (business rejection published as an event), retry (transient), or dead-letter (bug).

### Consistency
- A small error model: {{Error(Code, Message, Kind)}} with kinds Validation, NotFound, Forbidden, Conflict, Rule.
- One mapping function per adapter type.
- Stable machine-readable codes; human messages can change.
- Unexpected exceptions handled by global middleware ({{IExceptionHandler}}) returning a 500 ProblemDetails with a trace id, without leaking internals.`,
  code: r`~~~csharp
public enum ErrorKind { Validation, NotFound, Forbidden, Conflict, Rule }
public sealed record Error(string Code, string Message, ErrorKind Kind);

// HTTP adapter mapping (one place)
public static class ResultHttp
{
    public static IResult ToHttp<T>(this Result<T> r, Func<T, IResult> ok) => r.IsSuccess ? ok(r.Value!) : r.Error!.ToProblem();
    public static IResult ToProblem(this Error e) => Results.Problem(
        statusCode: e.Kind switch
        {
            ErrorKind.Validation => 400, ErrorKind.NotFound => 404, ErrorKind.Forbidden => 403,
            ErrorKind.Conflict => 409, _ => 422
        },
        title: e.Message, type: $"https://errors.example.com/{e.Code}",
        extensions: new Dictionary<string, object?> { ["code"] = e.Code });
}

// Unexpected exceptions: global handler, no internals leaked
public sealed class UnhandledExceptionHandler(ILogger<UnhandledExceptionHandler> log) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext ctx, Exception ex, CancellationToken ct)
    {
        log.LogError(ex, "Unhandled exception");
        await Results.Problem(statusCode: 500, title: "Unexpected error",
            extensions: new Dictionary<string, object?> { ["traceId"] = Activity.Current?.TraceId.ToString() }).ExecuteAsync(ctx);
        return true;
    }
}

// Message adapter: business rejection = outcome, transient = retry, bug = dead-letter
var result = await handler.Handle(cmd, ct);
if (result.IsFailure && result.Error!.Kind is ErrorKind.Rule or ErrorKind.Conflict)
    await publisher.PublishAsync(new CaptureRejected(cmd.PaymentId.Value, result.Error.Code), ct);
~~~`,
  pts: [r`Errors originate per ring: domain rules, application outcomes, infrastructure failures.`, r`Use cases return Results; adapters translate.`, r`One mapping per adapter type; stable codes.`, r`Global exception handler for the unexpected, with trace ids.`, r`Consumers distinguish business rejection, transient failure and bug.`],
  ex: r`Three teams mapped the same insufficient-funds error to 400, 409 and 500; the mobile app showed "something went wrong" for a normal decline. A shared error model and one ProblemDetails mapper made declines show the right message and cut support calls.`,
  fu: [r`Where do you translate a duplicate-key exception?`, r`How do clients rely on problem types?`, r`Should validation errors list every field?`],
  pit: [r`HTTP status codes inside use cases.`, r`Leaking stack traces in responses.`, r`Retrying business rejections from queues.`] },

{ id: 'q14', level: 'Intermediate', tags: ['clean-architecture', 'validation', 'fluentvalidation'],
  q: r`Where does validation live in Clean Architecture: request DTO validation, command validation with FluentValidation, domain invariants, and checks that need the database? Avoid duplication without losing safety.`,
  a: r`### Layers
| Layer | What | How |
|---|---|---|
| **Edge** (Api) | shape: required fields, formats, lengths, enum values | minimal API filters, DataAnnotations or FluentValidation on DTOs; returns 400 |
| **Application** (command) | simple cross-field rules, existence checks that need data (merchant exists, currency supported) | FluentValidation validators (async rules via ports) in the pipeline, or explicit checks in the handler |
| **Domain** | **invariants**: always enforced, whoever calls (capture ≤ authorised, valid state transition) | constructors, value objects, methods |

### Avoiding duplication
- Do **not** re-implement invariants in validators "for better messages". Instead, value objects expose {{TryCreate}} returning errors, which validators and endpoints reuse.
- Edge validation is about **shape**; domain is about **truth**. Some overlap (amount > 0) is acceptable when the domain check is the guarantee and the edge check gives a friendly early error.

### Database-dependent checks
Uniqueness ("email already registered") cannot be fully guaranteed by a pre-check (race). Use a **unique constraint** as the guarantee and translate the violation into a validation error; a pre-check only improves UX.

### Async validators
Keep them few and cheap; each database round trip in validation adds latency to every request.`,
  code: r`~~~csharp
// Edge: shape validation on the DTO
public sealed class OpenAccountRequestValidator : AbstractValidator<OpenAccountRequest>
{
    public OpenAccountRequestValidator()
    {
        RuleFor(x => x.Currency).NotEmpty().Length(3);
        RuleFor(x => x.Email).NotEmpty().Must(e => EmailAddress.Create(e).IsSuccess).WithMessage("Email is not valid");  // reuse VO rule
    }
}

// Application: data-dependent check through a port
public sealed class OpenAccountValidator : AbstractValidator<OpenAccount>
{
    public OpenAccountValidator(ISupportedCurrencies currencies) =>
        RuleFor(x => x.Currency).MustAsync((c, ct) => currencies.IsSupportedAsync(c, ct)).WithMessage("Currency not supported");
}

// Domain: invariants always enforced
public static Account Open(CustomerId owner, EmailAddress email, Currency currency, AccountLimits limits)
{
    if (limits.Overdraft.Currency != currency.Code) throw new DomainException("Overdraft currency must match account currency");
    return new Account(AccountId.New(), owner, email, currency, limits);
}

// Uniqueness: constraint is the guarantee, translated to a validation error
catch (DbUpdateException ex) when (ex.IsUniqueViolation("UX_Accounts_Email"))
{
    return Result.Fail<AccountId>(new Error("account.email_taken", "Email already registered", ErrorKind.Validation));
}
~~~`,
  pts: [r`Edge validates shape; application validates data-dependent rules; domain enforces invariants.`, r`Reuse value-object validation instead of duplicating rules.`, r`Uniqueness is guaranteed by constraints, not pre-checks.`, r`Translate constraint violations to validation errors.`, r`Keep async validators few and cheap.`],
  ex: r`A registration flow checked email uniqueness with a SELECT before INSERT; a double-click created duplicate accounts several times a day. A unique index with translation to a validation error eliminated duplicates; the pre-check stayed only for the friendly message.`,
  fu: [r`Should validators call repositories?`, r`How do you return all validation errors at once?`, r`Where do you validate authorization-dependent rules?`],
  pit: [r`Invariants only in validators.`, r`Pre-checks as the uniqueness guarantee.`, r`Many database calls in validators.`] },

{ id: 'q15', level: 'Intermediate', tags: ['clean-architecture', 'hexagonal', 'onion', 'vertical-slice'],
  q: r`Clean vs Hexagonal vs Onion vs Vertical Slice architecture: what is genuinely different, what is the same, and how do you combine them in one .NET service?`,
  a: r`| | Hexagonal (Cockburn, 2005) | Onion (Palermo, 2008) | Clean (Martin, 2012) | Vertical Slice (Bogard) |
|---|---|---|---|---|
| Core idea | application core with **ports**; **driving** (primary) and **driven** (secondary) adapters | concentric layers around the domain model | concentric rings with **use cases** and the Dependency Rule | organise by **feature/request**, not by layer |
| Inner structure | unspecified | domain model → domain services → application services | entities → use cases | each slice owns its handler, validation, data access |
| Emphasis | symmetry of inputs and outputs; testing via ports | domain model centrality | use cases as first-class; screaming architecture | minimise coupling between features, maximise cohesion within |

### The same
Hexagonal, Onion and Clean share the essential rule: **dependencies point toward the core**, infrastructure is a plug-in, and the core is testable in isolation.

### Genuinely different: vertical slices
Slices cut across layers. Each feature can choose its own complexity: a CRUD slice may use EF directly; a complex slice uses the domain model.

### Combining
- Projects for **direction** (Domain, Application, Infrastructure, Api) as in Clean.
- **Feature folders** (slices) inside Application and Api: {{Features/Refunds/IssueRefund}} with command, handler, validator, endpoint together.
- Domain model used by complex slices; simple slices query directly.
- Hexagonal vocabulary (driving/driven ports) to explain adapters.`,
  code: r`~~~text
src/Payments.Application/Features/
  Refunds/
    IssueRefund/
      IssueRefund.cs              command + result
      IssueRefundHandler.cs       uses domain + ports
      IssueRefundValidator.cs
  MerchantStatements/
    GetStatement/
      GetStatement.cs             query + DTO
      GetStatementHandler.cs      uses IStatementQueries (projection), no domain objects
src/Payments.Api/Features/
  Refunds/RefundEndpoints.cs      maps HTTP -> IssueRefund
~~~
~~~csharp
// A simple slice can stay simple: query port + projection, no aggregates
public sealed class GetStatementHandler(IStatementQueries queries) : IHandler<GetStatement, StatementDto>
{
    public async Task<StatementDto> Handle(GetStatement q, CancellationToken ct) =>
        new(q.MerchantId, await queries.LinesAsync(new MerchantId(q.MerchantId), q.From, ct));
}
~~~`,
  pts: [r`Hexagonal, Onion and Clean share the inward dependency rule.`, r`Hexagonal emphasises ports and adapters; Onion the domain model; Clean use cases.`, r`Vertical slices organise by feature and let complexity vary per slice.`, r`Combine: projects for direction, slices for features.`, r`Pick one vocabulary per codebase.`],
  ex: r`A team debating Onion vs Clean for weeks realised both described the same dependencies; they settled on Clean projects with feature folders inside, and the debate turned into a one-page convention document.`,
  fu: [r`Can vertical slices share code?`, r`Where does the domain model live in a slice-first codebase?`, r`What is a driving vs driven port?`],
  pit: [r`Treating the styles as competing religions.`, r`Layer-first folders with features scattered across 6 projects.`, r`Slices duplicating domain rules.`] },

{ id: 'q16', level: 'Intermediate', tags: ['clean-architecture', 'queries', 'cqrs', 'read-side'],
  q: r`Do read operations need to go through the domain model and repositories? Design the query side of a Clean Architecture service (CQRS-lite) without breaking the Dependency Rule.`,
  a: r`### No
The domain model exists to enforce **invariants on writes**. Reads have no invariants to protect; routing them through aggregates and repositories costs performance (loading whole aggregates, N+1) and bends aggregates to fit screens.

### CQRS-lite options
1. **Query ports**: Application defines {{IStatementQueries}} returning DTOs; Infrastructure implements with EF projections ({{AsNoTracking}}, {{Select}}) or Dapper/SQL views. The Dependency Rule holds.
2. **Read-side handlers in Infrastructure** (or an Api-level Queries folder) using the DbContext directly, documented as the convention. Simpler, but read code depends on EF.
3. **Separate read store** (projections from events) when scale or shape demands it.

### Rules
- Queries never modify state; commands return minimal results (ids, versions).
- Query DTOs are designed for consumers (screens, APIs), versioned with the API.
- Pagination (keyset), filtering and authorization filters (tenant, ownership) applied in the query.
- Caching belongs to the read side.

### Authorization on reads
Row-level filters (tenant, merchant) must be applied consistently: a query-port base filter or EF global query filters plus database RLS.`,
  code: r`~~~csharp
// Application: query + port
public sealed record GetMerchantPayments(Guid MerchantId, DateTime? Before, int PageSize = 50);
public interface IPaymentQueries
{
    Task<PageDto<PaymentListItem>> ForMerchantAsync(MerchantId m, DateTime? before, int pageSize, CancellationToken ct);
}

// Infrastructure: projection, keyset paging, tenant filter, no aggregates
internal sealed class PaymentQueries(PaymentsDbContext db, ICurrentMerchant current) : IPaymentQueries
{
    public async Task<PageDto<PaymentListItem>> ForMerchantAsync(MerchantId m, DateTime? before, int size, CancellationToken ct)
    {
        if (m != current.Id) throw new ForbiddenException();
        var q = db.Payments.AsNoTracking().Where(p => p.MerchantId == m);
        if (before is { } b) q = q.Where(p => p.CreatedUtc < b);
        var items = await q.OrderByDescending(p => p.CreatedUtc).Take(size + 1)
            .Select(p => new PaymentListItem(p.Id.Value, p.CreatedUtc, p.Amount.Amount, p.Amount.Currency, p.Status.ToString()))
            .ToListAsync(ct);
        return PageDto.From(items, size);
    }
}
~~~`,
  pts: [r`Reads do not need aggregates or repositories.`, r`Query ports keep the Dependency Rule; Infrastructure projects DTOs.`, r`Or a documented read-side convention using the DbContext directly.`, r`Keyset paging, consumer-shaped DTOs, authorization filters in queries.`, r`Separate read stores only when scale or shape demands.`],
  ex: r`A merchant portal's list page loaded 200 Payment aggregates (with refunds and events) per request; p95 was 3 seconds. A query port with projection and keyset paging brought it to 40 ms and removed pressure to add navigation properties to aggregates.`,
  fu: [r`Should queries go through the same pipeline behaviours as commands?`, r`How do you cache query results safely?`, r`When do you move to a separate read store?`],
  pit: [r`Loading aggregates for screens.`, r`Commands returning full read models.`, r`Inconsistent authorization filters across queries.`] },

{ id: 'q17', level: 'Intermediate', tags: ['clean-architecture', 'current-user', 'time', 'ports'],
  q: r`How do inner rings get the current user, tenant, time, configuration and correlation ids without depending on ASP.NET Core? Design the small ports for ambient context.`,
  a: r`### Ports for ambient context
| Need | Port (Application) | Adapter (outer) |
|---|---|---|
| current user | {{ICurrentUser}} (Id, roles, permissions) | from {{HttpContext.User}} in Api; from message headers in consumers; system user in jobs |
| tenant | {{ITenantContext}} | token claim, message header |
| time | {{TimeProvider}} (.NET 8 abstraction) | {{TimeProvider.System}}; {{FakeTimeProvider}} in tests |
| ids | {{IIdGenerator}} if needed | Guid v7, sequence |
| configuration | options records defined in Application ({{RefundOptions}}) | bound from configuration in the host |
| correlation | {{Activity.Current}} (System.Diagnostics, not a framework dependency) | set by ASP.NET Core and messaging instrumentation |

### Rules
- Ports are **small** and expressed in application terms (UserId, permissions), not {{ClaimsPrincipal}}.
- The **domain** rarely needs them: pass values in (time, user id) as method parameters; this keeps domain tests trivial.
- Each primary adapter (HTTP, consumer, job) provides its own implementation, so use cases work identically from any entry point.
- Options: the Application project defines plain option classes; using {{IOptions<T>}} from Microsoft.Extensions.Options is an acceptable, stable dependency for many teams; some inject the options record directly.`,
  code: r`~~~csharp
// Application ports
public interface ICurrentUser { UserId Id { get; } bool Has(Permission p); }
public interface ITenantContext { TenantId TenantId { get; } }
public sealed record RefundOptions { public decimal MaxAgentRefund { get; init; } = 500m; }

// Api adapter
internal sealed class HttpCurrentUser(IHttpContextAccessor http) : ICurrentUser
{
    private ClaimsPrincipal User => http.HttpContext?.User ?? throw new InvalidOperationException("No HTTP context");
    public UserId Id => new(Guid.Parse(User.FindFirstValue("sub")!));
    public bool Has(Permission p) => User.HasClaim("perm", p.Name);
}

// Consumer adapter: identity from message headers
internal sealed class MessageCurrentUser(IMessageContextAccessor msg) : ICurrentUser
{
    public UserId Id => new(Guid.Parse(msg.Current.Headers["x-user-id"]!));
    public bool Has(Permission p) => msg.Current.Headers["x-perms"]!.Split(',').Contains(p.Name);
}

// Use case: passes values into the domain rather than giving it ports
public async Task<Result> Handle(IssueRefund cmd, CancellationToken ct)
{
    if (cmd.Amount.Amount > options.MaxAgentRefund && !user.Has(Permission.LargeRefunds)) return Result.Forbidden();
    var payment = await payments.GetAsync(cmd.PaymentId, ct);
    payment!.Refund(cmd.Amount, cmd.Reason, requestedBy: user.Id, at: clock.GetUtcNow());
    await uow.SaveChangesAsync(ct);
    return Result.Ok();
}
~~~`,
  pts: [r`Small application-owned ports for user, tenant and ids; TimeProvider for time.`, r`Adapters per entry point: HTTP, consumers, jobs.`, r`Pass time and user into the domain as parameters.`, r`Options as plain records defined in Application.`, r`No ClaimsPrincipal or HttpContext inside use cases.`],
  ex: r`A batch job reused a use case that read the user from HttpContext and crashed with null references at 2 a.m.; the team had patched it with a fake HttpContext. Introducing ICurrentUser with a system-user adapter for jobs removed the hack.`,
  fu: [r`How do you propagate the user identity through asynchronous messages securely?`, r`Is IOptions<T> in Application a Dependency Rule violation?`, r`How do you test time-dependent use cases?`],
  pit: [r`HttpContext in Application.`, r`DateTime.UtcNow in domain logic.`, r`Use cases that only work from HTTP.`] },

{ id: 'q18', level: 'Intermediate', tags: ['clean-architecture', 'minimal-apis', 'controllers', 'primary-adapters'],
  q: r`Endpoints as primary adapters: minimal APIs vs controllers, how thin they should be, how to organise them by feature, and what belongs there (auth, versioning, OpenAPI, rate limits, ProblemDetails).`,
  a: r`### Role
An endpoint is a **driving adapter**: it translates HTTP into a use-case call and the result back into HTTP. It owns **transport concerns** only.

### Belongs in the endpoint (or its group)
- Route, verb, versioning, OpenAPI metadata.
- Authentication and coarse **policy-based authorization** ({{RequireAuthorization("payments:refund")}}).
- Rate limiting, request size limits, output caching for queries.
- Binding and **shape validation**; mapping DTO → command; mapping result → status code and ProblemDetails.
- Idempotency-key header extraction (passed into the command).

### Does not belong
Business rules, data access, calls to multiple use cases with orchestration logic, transactions.

### Minimal APIs vs controllers
Both are fine adapters. Minimal APIs: less ceremony, endpoint filters, faster startup, AOT-friendly, natural with feature folders ({{MapGroup}}). Controllers: familiar, model binding conventions, filters. Consistency within a codebase matters more than the choice.

### Organisation
One static class per feature mapping its endpoints ({{RefundEndpoints.Map(app)}}), grouped with {{MapGroup("/payments").WithTags("Payments")}}; shared conventions (auth, ProblemDetails, versioning) on the group.`,
  code: r`~~~csharp
public static class RefundEndpoints
{
    public static RouteGroupBuilder MapRefunds(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/v1/payments/{paymentId:guid}/refunds")
                   .WithTags("Refunds").RequireAuthorization("payments:refund").RequireRateLimiting("per-merchant");

        g.MapPost("/", async (Guid paymentId, IssueRefundRequest body, [FromHeader(Name = "Idempotency-Key")] Guid key,
                              IHandler<IssueRefund, Result<RefundResult>> handler, ICurrentUser user, CancellationToken ct) =>
            (await handler.Handle(body.ToCommand(paymentId, key, user.Id), ct))
                .ToHttp(r => TypedResults.Created($"/v1/payments/{paymentId}/refunds/{r.RefundId}", r)))
         .WithName("IssueRefund")
         .Produces<RefundResult>(StatusCodes.Status201Created)
         .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
         .AddEndpointFilter<ValidationFilter<IssueRefundRequest>>();

        return g;
    }
}

// Program.cs
app.MapRefunds();
~~~`,
  pts: [r`Endpoints are driving adapters: HTTP in, use case call, HTTP out.`, r`Transport concerns only: routing, auth policies, limits, shape validation, mapping.`, r`No business rules, data access or orchestration.`, r`Minimal APIs or controllers: be consistent.`, r`Group endpoints by feature with shared conventions.`],
  ex: r`A controller grew to 900 lines including fee calculations and SQL; the same logic was missing from the message consumer, so refunds via API and via queue charged different fees. Moving logic into a use case called by both adapters removed the inconsistency.`,
  fu: [r`How do you version endpoints without duplicating use cases?`, r`Where does output caching fit?`, r`How do you generate OpenAPI that front-end teams can consume?`],
  pit: [r`Fat controllers.`, r`Different logic for HTTP and message entry points.`, r`Authorization rules spread across handlers and endpoints inconsistently.`] },

{ id: 'q19', level: 'Senior', tags: ['clean-architecture', 'transactions', 'outbox', 'external-calls'],
  q: r`A use case updates an aggregate, calls a payment provider, and must publish an event. Where do the transaction boundaries go, how do you avoid holding a transaction across the external call, and how does the outbox fit Clean Architecture?`,
  a: r`### The problem
A database transaction cannot include the payment provider. Options that look simple are wrong:
- Call the provider **inside** the transaction: locks held for the provider's latency; if the commit fails after the provider succeeded, money moved with no record.
- Call the provider **after** commit without a record of intent: a crash between commit and call loses the action.

### Pattern: record intent, act, record outcome
1. **Transaction 1**: domain records the intent ({{Refund}} in state Requested), outbox row or job scheduled; commit.
2. **External call** outside any transaction, with an **idempotency key** derived from the intent id (safe to retry).
3. **Transaction 2**: record the outcome ({{Confirmed}} / {{Failed}}), raise domain events, outbox rows; commit.
4. A **recovery process** finds intents stuck in Requested (crash between steps) and retries step 2 using the same idempotency key.

### Where things live
- Use case orchestrates steps; domain owns states and rules.
- {{IUnitOfWork}} port for commits; the **outbox** is an Infrastructure concern triggered by domain events in SaveChanges (interceptor), invisible to the use case.
- For long or multi-provider flows, move the steps to a **process manager** driven by outbox messages instead of one request.

### Result to the caller
Either wait for step 3 within a timeout, or return **202 Accepted** with a status resource.`,
  dia: r`sequenceDiagram
  participant UC as Use case
  participant DB as Database
  participant PSP as Payment provider
  UC->>DB: Tx1 refund Requested + outbox
  UC->>PSP: Refund with idempotency key = refund id
  PSP-->>UC: Ack
  UC->>DB: Tx2 refund Confirmed + RefundConfirmed event
  Note over UC,DB: Recovery job retries refunds stuck in Requested with the same key`,
  code: r`~~~csharp
public sealed class IssueRefundHandler(IPaymentRepository payments, IRefundGateway gateway, IUnitOfWork uow, TimeProvider clock)
{
    public async Task<Result<RefundResult>> Handle(IssueRefund cmd, CancellationToken ct)
    {
        // Tx 1: record intent
        var payment = await payments.GetAsync(cmd.PaymentId, ct);
        if (payment is null) return Result.NotFound<RefundResult>("payment.not_found");
        var refund = payment.RequestRefund(cmd.Amount, cmd.Reason, clock.GetUtcNow());     // state: Requested
        await uow.SaveChangesAsync(ct);

        // External call: no transaction open, idempotent by refund id
        RefundAck ack;
        try { ack = await gateway.RefundAsync(payment.GatewayRef, cmd.Amount, idempotencyKey: refund.Id.ToString(), ct); }
        catch (Exception ex) when (ex is TimeoutException or HttpRequestException)
        {
            return Result.Accepted(new RefundResult(refund.Id.Value, "Pending"));          // recovery job completes it
        }

        // Tx 2: record outcome
        payment.ConfirmRefund(refund.Id, ack.Reference);
        await uow.SaveChangesAsync(ct);                                                     // RefundConfirmed -> outbox
        return Result.Ok(new RefundResult(refund.Id.Value, "Confirmed"));
    }
}

// Recovery: retry stuck intents with the same key
public sealed class StuckRefundRecovery(IRefundQueries q, IHandler<RetryRefund, Result> retry) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var t = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await t.WaitForNextTickAsync(stop))
            foreach (var id in await q.RequestedOlderThanAsync(TimeSpan.FromMinutes(2), stop))
                await retry.Handle(new RetryRefund(id), stop);
    }
}
~~~`,
  pts: [r`Never hold a database transaction across an external call.`, r`Record intent, act with an idempotency key, record outcome.`, r`A recovery process completes intents stuck between steps.`, r`Outbox is an infrastructure concern triggered from SaveChanges.`, r`Long flows move to a process manager; callers may get 202.`],
  ex: r`A refund endpoint called the PSP inside a database transaction; when the commit failed on a deadlock after the PSP succeeded, customers were refunded twice on retry. The intent/act/outcome pattern with refund-id idempotency keys ended double refunds.`,
  fu: [r`What if the payment provider has no idempotency support?`, r`How do you show a pending refund to the user?`, r`When would you move this flow into a saga?`],
  pit: [r`External calls inside transactions.`, r`No record of intent before acting.`, r`Retries with new idempotency keys.`] },

{ id: 'q20', level: 'Senior', tags: ['clean-architecture', 'domain-events', 'dispatching', 'side-effects'],
  q: r`How are domain events dispatched in a Clean Architecture service? Compare in-transaction dispatch, after-commit dispatch, and outbox-based handling, and decide where each kind of handler lives.`,
  a: r`### Raising
Aggregates add events to an internal list. The infrastructure (SaveChanges interceptor or unit of work) collects them.

### Dispatch options
| Option | When | Risk |
|---|---|---|
| **Before commit, same transaction** | in-context side effects that must be atomic and are cheap (update another aggregate's counter in the same database) | larger transactions, handler failures roll back the use case, ordering surprises |
| **After commit, in process** | non-critical side effects (cache invalidation, metrics) | lost if the process crashes after commit |
| **Outbox** (persisted with the commit, processed asynchronously) | anything that must happen reliably: integration events, emails, other contexts, external calls | eventual consistency; handlers must be idempotent |

### Where handlers live
- Handlers that update other aggregates: **Application** (they are use cases triggered by events).
- Handlers that talk to infrastructure (send email, publish to broker): Application handler calling a **port**, implemented in Infrastructure.
- Translation of domain events to **integration events**: Infrastructure or an Application mapping, published via outbox.

### Default
Outbox for everything that crosses a boundary or does I/O; in-transaction dispatch only for small, local, atomic consistency needs, used sparingly.`,
  code: r`~~~csharp
// Infrastructure: collect events at SaveChanges and persist them to the outbox atomically
internal sealed class OutboxInterceptor(IDomainEventSerializer serializer) : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData d, InterceptionResult<int> r, CancellationToken ct = default)
    {
        var db = d.Context!;
        foreach (var agg in db.ChangeTracker.Entries<IHasDomainEvents>().Select(e => e.Entity).ToList())
        {
            foreach (var e in agg.DomainEvents) db.Set<OutboxMessage>().Add(serializer.ToOutbox(e));
            agg.ClearEvents();
        }
        return base.SavingChangesAsync(d, r, ct);
    }
}

// Outbox processor dispatches to Application handlers (idempotent)
public sealed class SendRefundEmail(IEmailSender email, ICustomerDirectory customers) : IDomainEventHandler<RefundConfirmed>
{
    public async Task Handle(RefundConfirmed e, CancellationToken ct)
    {
        var c = await customers.GetContactAsync(e.CustomerId, ct);
        await email.SendAsync(c.Email, EmailTemplates.RefundConfirmed(e), idempotencyKey: $"refund-email-{e.RefundId}", ct);
    }
}

// Rare: in-transaction handler for local atomic consistency
public sealed class UpdateMerchantRefundTotals(IMerchantStatsRepository stats) : IInTransactionHandler<RefundConfirmed>
{
    public async Task Handle(RefundConfirmed e, CancellationToken ct) => (await stats.GetAsync(e.MerchantId, ct)).AddRefund(e.Amount);
}
~~~`,
  pts: [r`Aggregates raise; infrastructure collects at SaveChanges.`, r`In-transaction dispatch only for small local atomic needs.`, r`After-commit in-process dispatch is lossy.`, r`Outbox for anything reliable, cross-boundary or I/O.`, r`Handlers are application code calling ports; idempotent.`],
  ex: r`A service sent confirmation emails from an in-process after-commit handler; pod restarts during deployments lost a few hundred emails per release. Moving to outbox-driven handlers with idempotent sends eliminated the losses.`,
  fu: [r`How do you order handlers for the same event?`, r`What happens if an in-transaction handler throws?`, r`How do you test outbox-driven handlers?`],
  pit: [r`Sending emails or calling APIs inside the transaction.`, r`After-commit in-memory dispatch for critical side effects.`, r`Non-idempotent outbox handlers.`] },

{ id: 'q21', level: 'Senior', tags: ['clean-architecture', 'driven-adapters', 'resilience', 'http'],
  q: r`Design a driven adapter for an unreliable external API (KYC provider): the port contract, translation, resilience (timeouts, retries, circuit breaker), caching, and how failures are represented to the use case.`,
  a: r`### Port contract (Application)
In application terms: {{Task<VerificationOutcome> VerifyAsync(Applicant, ct)}}. Outcomes are explicit: Passed, Failed, ManualReview, **Unavailable** (a valid business-level outcome for "we could not decide now"). No vendor types, no HTTP status codes.

### Adapter (Infrastructure)
- Typed {{HttpClient}} with **Microsoft.Extensions.Http.Resilience**: total timeout, attempt timeout, retries with jitter for idempotent calls only, circuit breaker, (optionally) hedging.
- **Translation** of vendor statuses and error codes (ACL): unknown statuses fail loudly.
- **Idempotency**: pass a request id so retries do not create duplicate checks (and duplicate charges from the vendor).
- **Caching** of stable results where allowed (a verified identity for 30 days), keyed carefully.
- **Observability**: dependency metrics (latency, errors, breaker state), traces with vendor request ids.

### Use case behaviour
The use case decides what Unavailable means: queue the application for later verification, allow limited onboarding, or reject. This is **business policy**, not infrastructure.

### Testing
Adapter tests against WireMock with recorded vendor responses (including weird ones), contract tests for the port, and a sandbox run nightly.`,
  code: r`~~~csharp
// Application port
public enum VerificationOutcome { Passed, Failed, ManualReview, Unavailable }
public interface IIdentityVerification { Task<VerificationOutcome> VerifyAsync(Applicant applicant, Guid requestId, CancellationToken ct); }

// Infrastructure adapter with resilience and translation
builder.Services.AddHttpClient<IIdentityVerification, KycVendorAdapter>(c => c.BaseAddress = new Uri(cfg["Kyc:BaseUrl"]!))
    .AddResilienceHandler("kyc", p =>
    {
        p.AddTimeout(TimeSpan.FromSeconds(10));                                       // total
        p.AddRetry(new() { MaxRetryAttempts = 2, BackoffType = DelayBackoffType.Exponential, UseJitter = true });
        p.AddCircuitBreaker(new() { FailureRatio = 0.5, MinimumThroughput = 20, BreakDuration = TimeSpan.FromSeconds(30) });
        p.AddTimeout(TimeSpan.FromSeconds(3));                                        // per attempt
    });

internal sealed class KycVendorAdapter(HttpClient http, ILogger<KycVendorAdapter> log) : IIdentityVerification
{
    public async Task<VerificationOutcome> VerifyAsync(Applicant a, Guid requestId, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/v2/checks") { Content = JsonContent.Create(VendorRequest.From(a)) };
            req.Headers.Add("Idempotency-Key", requestId.ToString());
            using var resp = await http.SendAsync(req, ct);
            resp.EnsureSuccessStatusCode();
            var body = await resp.Content.ReadFromJsonAsync<VendorCheck>(ct);
            return body!.Result switch
            {
                "clear" => VerificationOutcome.Passed,
                "consider" => VerificationOutcome.ManualReview,
                "rejected" => VerificationOutcome.Failed,
                var other => throw new UnknownVendorStatusException(other)
            };
        }
        catch (Exception ex) when (ex is HttpRequestException or TimeoutRejectedException or BrokenCircuitException)
        {
            log.LogWarning(ex, "KYC vendor unavailable for request {RequestId}", requestId);
            return VerificationOutcome.Unavailable;                                   // business decides what this means
        }
    }
}
~~~`,
  pts: [r`Port in application terms, including an explicit Unavailable outcome.`, r`Adapter: typed HttpClient, resilience pipeline, translation, idempotency.`, r`Retries only for idempotent calls, with timeouts per attempt and total.`, r`What Unavailable means is business policy in the use case.`, r`WireMock and contract tests plus nightly sandbox runs.`],
  ex: r`A KYC vendor outage turned into a full onboarding outage because the adapter threw and the use case had no policy. After introducing Unavailable with a "queue for later verification" policy, the next vendor outage only delayed approvals by two hours.`,
  fu: [r`Should retries live in the adapter or in the use case?`, r`How do you cache vendor results safely?`, r`How do you detect vendor behaviour changes?`],
  pit: [r`Vendor exceptions leaking into use cases.`, r`Retrying non-idempotent calls.`, r`No timeouts.`] },

{ id: 'q22', level: 'Senior', tags: ['clean-architecture', 'message-consumers', 'background-jobs', 'primary-adapters'],
  q: r`Message consumers, scheduled jobs and CLIs as primary adapters: how do they invoke the same use cases as HTTP endpoints, and what is different about scopes, identity, retries and error handling?`,
  a: r`### Same core, different drivers
A consumer, a job and an endpoint are all **driving adapters**: they translate their input into a command and call the same use case. Business behaviour must not differ by entry point.

### Differences to handle in the adapter
| Concern | HTTP | Consumer / job |
|---|---|---|
| DI scope | per request (framework) | **create a scope per message/batch** |
| Identity | token → ICurrentUser | message headers or a **system user** with explicit permissions |
| Cancellation | RequestAborted | host stopping token, per-message timeout |
| Errors | ProblemDetails to the client | business rejection → publish outcome event and ack; transient → retry/nack; poison → dead-letter |
| Idempotency | Idempotency-Key header | message id / business key (redelivery is normal) |
| Ordering | per request | partition key; per-aggregate ordering |
| Concurrency | many requests | bounded parallel consumers |

### Rules
- Keep consumers thin: deserialize, map, call the use case, decide ack/retry.
- One message = one unit of work (or a small batch with clear semantics).
- Do not reuse HTTP-only adapters (HttpContext-based user) in consumers.`,
  code: r`~~~csharp
public sealed class RefundRequestedConsumer(IServiceScopeFactory scopes, ILogger<RefundRequestedConsumer> log) : IConsumer<RefundRequestedV1>
{
    public async Task Consume(ConsumeContext<RefundRequestedV1> ctx)
    {
        await using var scope = scopes.CreateAsyncScope();                                   // scope per message
        var sp = scope.ServiceProvider;
        sp.GetRequiredService<MessageIdentity>().Set(ctx.Headers.Get<string>("x-user-id"), SystemPermissions.Refunds);
        var handler = sp.GetRequiredService<IHandler<IssueRefund, Result<RefundResult>>>();

        var m = ctx.Message;
        var result = await handler.Handle(new IssueRefund(new PaymentId(m.PaymentId), new Money(m.Amount, m.Currency),
                                                          RefundReason.Parse(m.Reason), CommandId: m.RequestId), ctx.CancellationToken);
        if (result.IsFailure && result.Error!.Kind is ErrorKind.Rule or ErrorKind.NotFound)
        {
            await ctx.Publish(new RefundRejectedV1(m.RequestId, result.Error.Code));          // business outcome: ack
            return;
        }
        // transient exceptions propagate -> broker retry policy; exhausted -> dead-letter queue
    }
}

// Scheduled job: same use case, system identity
public sealed class ExpireAuthorisationsJob(IServiceScopeFactory scopes, TimeProvider clock) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var t = new PeriodicTimer(TimeSpan.FromMinutes(5), clock);
        while (await t.WaitForNextTickAsync(stop))
        {
            await using var s = scopes.CreateAsyncScope();
            await s.ServiceProvider.GetRequiredService<IHandler<ExpireStaleAuthorisations, Result>>()
                .Handle(new ExpireStaleAuthorisations(clock.GetUtcNow()), stop);
        }
    }
}
~~~`,
  pts: [r`Consumers, jobs and endpoints are driving adapters for the same use cases.`, r`Scope per message, identity from headers or a system user.`, r`Business rejections are acked outcomes; transient failures retry; poison dead-letters.`, r`Idempotency by message id or business key.`, r`Thin consumers; one message, one unit of work.`],
  ex: r`A refunds consumer reimplemented the refund logic separately from the HTTP use case; the two diverged on fee reversal and finance found 4,000 refunds with fees not reversed. Routing both through the same use case fixed it.`,
  fu: [r`How do you propagate identity securely in messages?`, r`How do you batch messages without breaking unit-of-work semantics?`, r`How do you test consumers?`],
  pit: [r`Separate business logic per entry point.`, r`Scoped services resolved from the root provider in consumers.`, r`Retrying business rejections.`] },

{ id: 'q23', level: 'Senior', tags: ['clean-architecture', 'multi-tenancy', 'isolation'],
  q: r`Implement multi-tenancy in a Clean Architecture service: where tenant resolution, isolation and tenant-specific configuration live, and how to keep tenant handling out of business rules.`,
  a: r`### Layers
| Concern | Where |
|---|---|
| **Resolve tenant** from token claim, host name or message header | primary adapters (middleware, consumer filter) → sets {{ITenantContext}} |
| **Isolation of data** | Infrastructure: EF global query filters, write-side interceptor, database RLS, or database-per-tenant connection resolution |
| **Tenant-specific configuration** (fees, limits, features) | Application port {{ITenantSettings}} implemented in Infrastructure (cached) |
| **Business rules that differ per tenant** | domain policies selected by configuration (strategy), not if-statements on tenant id |

### Keeping it out of rules
Use cases and domain code should rarely mention tenants: isolation is automatic below them, and variability is expressed through policies or settings. A use case that writes {{if (tenant == "acme")}} is a smell.

### Isolation guarantees
- Shared database: tenant column + filters + **RLS** (filters are not a security boundary).
- Database per tenant: connection string resolved per request; pool budgets per tenant; migrations per database.
- Tests that attempt cross-tenant access in every critical query and command.

### Background work
Jobs iterate tenants explicitly, setting the tenant context per iteration; never rely on ambient context leaking from a request.`,
  code: r`~~~csharp
// Primary adapter: resolve tenant once
app.Use(async (ctx, next) =>
{
    var tenantId = ctx.User.FindFirstValue("tid");
    if (tenantId is null) { ctx.Response.StatusCode = 401; return; }
    ctx.RequestServices.GetRequiredService<TenantContext>().Set(new TenantId(Guid.Parse(tenantId)));
    await next();
});

// Infrastructure: isolation below the application
internal sealed class PaymentsDbContext(DbContextOptions<PaymentsDbContext> o, ITenantContext tenant) : DbContext(o), IUnitOfWork
{
    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Payment>().HasQueryFilter("Tenant", p => p.TenantId == tenant.TenantId);
    }
}

// Variability through policies chosen from tenant settings, not if-statements
public sealed class FeePolicyResolver(ITenantSettings settings, IEnumerable<IFeePolicy> policies)
{
    public async Task<IFeePolicy> ForCurrentTenantAsync(CancellationToken ct)
    {
        var s = await settings.GetAsync(ct);
        return policies.Single(p => p.Name == s.FeePolicyName);
    }
}

// Job: explicit tenant per iteration
foreach (var t in await tenants.ActiveAsync(stop))
{
    await using var scope = scopes.CreateAsyncScope();
    scope.ServiceProvider.GetRequiredService<TenantContext>().Set(t.Id);
    await scope.ServiceProvider.GetRequiredService<IHandler<RunDailyFees, Result>>().Handle(new RunDailyFees(today), stop);
}
~~~`,
  pts: [r`Resolve tenant in primary adapters; expose via ITenantContext.`, r`Isolation in Infrastructure: filters, write guards, RLS or database per tenant.`, r`Tenant-specific behaviour via settings and policies, not if-statements.`, r`Jobs set tenant context explicitly per iteration.`, r`Cross-tenant tests for critical paths.`],
  ex: r`A team scattered "if tenant == X" branches through use cases for three enterprise clients; by the tenth client the code was unmaintainable. Moving variations into per-tenant policy configuration let the next five clients onboard with no code changes.`,
  fu: [r`How does database-per-tenant change the infrastructure ring?`, r`How do you migrate 300 tenant databases?`, r`How do you test tenant isolation?`],
  pit: [r`Tenant checks in business rules.`, r`Query filters as the only isolation.`, r`Jobs relying on ambient tenant context.`] },

{ id: 'q24', level: 'Senior', tags: ['clean-architecture', 'authorization', 'security'],
  q: r`Where does authorization belong in Clean Architecture: endpoint policies, use-case permission checks, resource-based checks, or the domain? Design it for a payments API with agents, merchants and admins.`,
  a: r`### Layers of authorization
| Kind | Example | Where |
|---|---|---|
| **Authentication** | valid token | edge (middleware) |
| **Coarse permission** (can call this kind of operation at all) | {{payments:refund}} scope | endpoint policy ({{RequireAuthorization}}) |
| **Resource-based** (this user on this resource) | merchant may refund only its own payments; agent only for assigned merchants | **use case**, after loading the resource, via an {{IAuthorizationPolicy}} port |
| **Amount/limit rules** tied to roles | agents up to 500 GBP, supervisors above | use case or a policy object; sometimes a domain rule if the business treats it as one ("refund approval required above X") |
| **Data filtering** | lists show only permitted rows | query side filters + database RLS |

### Why use cases, not endpoints, for resource checks
Endpoints do not have the resource loaded; and other entry points (consumers, jobs) must enforce the same rules. Putting checks in use cases makes them apply everywhere.

### When it is domain
If the business language includes it ("refunds above 1,000 require supervisor approval"), it is a **domain rule** modelled explicitly (approval states), not a security filter.

### Implementation
ASP.NET Core authorization handlers can be reused by wrapping them in an application port; keep decisions centralised and auditable (log denials with reason).`,
  code: r`~~~csharp
// Application port for resource-based decisions
public interface IPaymentAuthorization
{
    Task<AuthzDecision> CanRefundAsync(ICurrentUser user, Payment payment, Money amount, CancellationToken ct);
}

// Infrastructure implementation (could wrap IAuthorizationService)
internal sealed class PaymentAuthorization(IAgentAssignments assignments) : IPaymentAuthorization
{
    public async Task<AuthzDecision> CanRefundAsync(ICurrentUser u, Payment p, Money amount, CancellationToken ct)
    {
        if (u.Has(Permission.Admin)) return AuthzDecision.Allow;
        if (u.MerchantId is { } m) return m == p.MerchantId ? AuthzDecision.Allow : AuthzDecision.Deny("not_own_payment");
        if (u.Has(Permission.Agent) && await assignments.IsAssignedAsync(u.Id, p.MerchantId, ct))
            return amount.Amount <= 500m || u.Has(Permission.Supervisor) ? AuthzDecision.Allow : AuthzDecision.Deny("over_agent_limit");
        return AuthzDecision.Deny("no_permission");
    }
}

// Use case: load, authorize against the resource, then act
var payment = await payments.GetAsync(cmd.PaymentId, ct);
if (payment is null) return Result.NotFound<RefundResult>("payment.not_found");
var decision = await authz.CanRefundAsync(user, payment, cmd.Amount, ct);
if (!decision.Allowed) { audit.Denied(user.Id, "refund", payment.Id, decision.Reason); return Result.Forbidden<RefundResult>(decision.Reason); }

// Endpoint: coarse permission only
g.MapPost("/", IssueRefundEndpoint).RequireAuthorization("payments:refund");
~~~`,
  pts: [r`Authenticate at the edge; coarse permissions on endpoints.`, r`Resource-based checks in use cases after loading the resource.`, r`Business approval rules are domain concepts.`, r`List filtering in queries plus RLS.`, r`Centralise decisions in a port; audit denials.`],
  ex: r`An API checked merchant ownership in controllers only; a new bulk-refund consumer called the use case directly and allowed a merchant to refund another merchant's payments through a crafted message. Moving the ownership check into the use case closed the hole for every entry point.`,
  fu: [r`How do you avoid N authorization queries for list endpoints?`, r`Should the domain know about roles?`, r`How do you test authorization matrices?`],
  pit: [r`Resource checks only in endpoints.`, r`Security rules mixed into domain entities.`, r`No audit of denials.`] },

{ id: 'q25', level: 'Senior', tags: ['clean-architecture', 'performance', 'abstractions', 'n-plus-one'],
  q: r`Critics say Clean Architecture makes services slow. What are the real performance costs (mapping, indirection, repositories, N+1, chatty ports), which are negligible, and how do you design hot paths?`,
  a: r`### Mostly negligible
- Interface dispatch and DI resolution: nanoseconds.
- A mapping step per request: microseconds and a few allocations.
Compared with a database round trip (milliseconds), these rarely matter.

### Real costs
- **Repositories loading whole aggregates** where a projection would do (reads through the domain).
- **N+1 through ports**: a use case loops over items calling {{repository.GetAsync(id)}} or {{gateway.GetPrice(sku)}} per item.
- **Chatty ports** designed one-item-at-a-time ({{GetRate(pair)}}) instead of batch ({{GetRates(pairs)}}).
- **Pipeline behaviours** doing I/O on every request (an async validator hitting the database for each command).
- **Transactions too long** because of orchestration inside them.

### Design for hot paths
1. Reads bypass the domain: query ports with projections, caching.
2. **Batch-shaped ports** when use cases process sets.
3. Bulk use cases ({{ApplyDailyFees}}) using set-based infrastructure operations, with domain rules applied per batch or expressed as SQL where justified and tested.
4. Measure: tracing per use case, query counts per request, allocation profiling; optimise where the numbers say.

### The answer to critics
The architecture does not dictate one aggregate per row in batch jobs or reads through repositories; those are design choices. Use Clean boundaries with performance-aware port design.`,
  code: r`~~~csharp
// N+1 through a chatty port
foreach (var line in order.Lines)
    line.Price = await pricing.GetPriceAsync(line.Sku, ct);            // 200 lines = 200 calls

// Batch-shaped port
public interface IPricing { Task<IReadOnlyDictionary<Sku, Money>> GetPricesAsync(IReadOnlyCollection<Sku> skus, CancellationToken ct); }
var prices = await pricing.GetPricesAsync(order.Lines.Select(l => l.Sku).ToArray(), ct);
order.Reprice(prices);

// Bulk use case with set-based infrastructure: rule defined once, applied in SQL via a port
public interface IDailyFeeRun { Task<int> ApplyAsync(DateOnly day, FeeSchedule schedule, CancellationToken ct); }
internal sealed class SqlDailyFeeRun(PaymentsDbContext db) : IDailyFeeRun
{
    public Task<int> ApplyAsync(DateOnly day, FeeSchedule s, CancellationToken ct) =>
        db.Accounts.Where(a => a.Status == AccountStatus.Active && a.Balance.Amount < s.MinimumBalance)
          .ExecuteUpdateAsync(u => u.SetProperty(a => a.FeesDue, a => a.FeesDue + s.LowBalanceFee), ct);
}
// Covered by tests asserting SQL-path results equal the domain calculation on sample data
~~~`,
  pts: [r`Interfaces, DI and mapping are cheap relative to I/O.`, r`Real costs: aggregates for reads, N+1 through ports, chatty ports, I/O in pipelines.`, r`Design batch-shaped ports; reads via projections.`, r`Set-based infrastructure for bulk use cases, verified against domain rules.`, r`Measure per use case before optimising.`],
  ex: r`An order-pricing use case called the pricing port once per line, taking 4 seconds for large B2B orders. A batch port returned all prices in one call and the use case dropped to 120 ms, with no change to the architecture.`,
  fu: [r`How do you keep domain rules and SQL bulk paths consistent?`, r`When is caching inside an adapter appropriate?`, r`How do you find N+1 through ports in production?`],
  pit: [r`Blaming the architecture for N+1 design.`, r`One-item ports for set-based use cases.`, r`Reads through repositories.`] },

{ id: 'q26', level: 'Senior', tags: ['clean-architecture', 'over-engineering', 'simplification'],
  q: r`A team has 12 projects, interfaces for every class, four mapping layers and a mediator for a CRUD API with almost no rules. What do you advise, and how do you simplify without losing what matters?`,
  a: r`### Diagnose
- How many real business rules exist? If most handlers are load-map-save, the domain is thin.
- Count pass-through layers (DTO → command → entity → persistence model → response with identical fields).
- Interfaces with exactly one implementation and no test double or volatility.
- Lead time, onboarding time, how many files change for a one-field addition.

### Advice
1. **Collapse projects** to what enforces something valuable: often Api + Core (+ Infrastructure if there are real adapters). For pure CRUD, one project with feature folders.
2. **Vertical slices** for simple features: endpoint + handler + EF query in one folder; no repository, no mapping chain.
3. Keep **ports** only for volatile external dependencies (payment provider, email, clock).
4. Remove the mediator if pipelines are trivial; use direct handlers or plain endpoints.
5. Keep one or two **architecture tests** for boundaries that remain.
6. Re-introduce structure where complexity appears (a rules-heavy feature gets a domain model).

### Measure
Files touched per change, lead time, onboarding feedback, defect rate before and after.

### Principle
Architecture is a means to protect business rules and allow change. Where there are no rules to protect, ceremony is pure cost.`,
  code: r`~~~text
Before (12 projects for CRUD):
  Api, Api.Contracts, Application, Application.Contracts, Application.Abstractions, Domain, Domain.Shared,
  Infrastructure, Infrastructure.Persistence, Infrastructure.Persistence.Abstractions, Mappings, SharedKernel
  Adding one field touched 11 files in 7 projects.

After:
  Catalog.Api          endpoints by feature, EF Core DbContext, slices
  Catalog.Tests
  Adding one field touches 3 files.
~~~
~~~csharp
// A simple slice: endpoint + EF directly; no repository, mediator or mapping chain
public static class UpdateProductName
{
    public sealed record Request(string Name);
    public static void Map(RouteGroupBuilder g) => g.MapPut("/{id:int}/name", async (int id, Request r, CatalogDb db, CancellationToken ct) =>
    {
        var p = await db.Products.FindAsync([id], ct);
        if (p is null) return Results.NotFound();
        p.Name = r.Name.Trim();
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }).AddEndpointFilter<ValidationFilter<Request>>();
}
~~~`,
  pts: [r`Count rules, pass-through layers and single-implementation interfaces.`, r`Collapse projects; use vertical slices for CRUD features.`, r`Keep ports only for volatile external dependencies.`, r`Drop the mediator if pipelines are trivial.`, r`Measure files per change, lead time and onboarding before and after.`],
  ex: r`A product-catalogue team simplified from 12 projects to 2 and cut the average pull request from 14 files to 4; when pricing rules later grew complex, they added a domain project only for pricing.`,
  fu: [r`How do you convince the original authors?`, r`What signals tell you to reintroduce layers?`, r`Which architecture tests would you keep?`],
  pit: [r`Clean Architecture as a template applied regardless of complexity.`, r`Interfaces for everything.`, r`Removing boundaries that protect real rules.`] },

{ id: 'q27', level: 'Senior', tags: ['clean-architecture', 'framework-gravity', 'attributes', 'serialization'],
  q: r`"Framework gravity": how do ASP.NET Core, EF Core and serializers pull types and attributes into inner rings over time, and what concrete practices keep the core clean?`,
  a: r`### How it happens
- **Attributes**: {{[Required]}}, {{[JsonPropertyName]}}, {{[Column]}}, {{[Key]}} added to domain classes for convenience.
- **Framework types**: {{IFormFile}}, {{ClaimsPrincipal}}, {{HttpContext}}, {{IQueryable}} from EF, {{DbSet}} passed into use cases.
- **Serialization needs**: public setters and parameterless constructors added "so JSON works".
- **ORM needs**: virtual navigation properties for lazy loading; collections exposed as {{List<T>}}.
- **Logging/telemetry** packages referenced from Domain.
- Each step is small and locally reasonable; the sum is a core that cannot be tested or changed independently.

### Practices
1. **Fluent configuration** for EF in Infrastructure; no data annotations in Domain.
2. **DTOs at the edges** for JSON; domain types never serialised directly (or custom converters in the Api project for value objects).
3. Application-level abstractions for files ({{Stream}} plus metadata record) and users ({{ICurrentUser}}).
4. **Architecture tests** forbidding framework namespaces and attributes in Domain/Application.
5. Code review checklist item: "does this change pull a framework concept inward?"
6. A Domain project with **no package references** at all (enforced by a test reading the csproj).

### Acceptable exceptions
Stable, low-level abstractions many teams accept in Application: {{Microsoft.Extensions.Logging.Abstractions}}, {{Microsoft.Extensions.Options}}, {{System.Diagnostics}} (Activity). Decide explicitly and write it down.`,
  code: r`~~~csharp
// Gravity in action (avoid)
public class Payment
{
    [Key] public Guid Id { get; set; }
    [JsonPropertyName("amt"), Column(TypeName = "decimal(19,4)")] public decimal Amount { get; set; }
    public virtual Merchant Merchant { get; set; } = null!;                // lazy-loading proxy
}
public Task<Result> Handle(IFormFile file, ClaimsPrincipal user) { /* framework types in a use case */ return default!; }

// Clean alternative: application abstractions at the edge
public sealed record UploadedDocument(string FileName, string ContentType, long Length, Func<Stream> Open);
app.MapPost("/disputes/{id:guid}/evidence", async (Guid id, IFormFile file, IHandler<AddEvidence, Result> h, CancellationToken ct) =>
    (await h.Handle(new AddEvidence(new DisputeId(id), new UploadedDocument(file.FileName, file.ContentType, file.Length, file.OpenReadStream)), ct)).ToHttp());

// Guard: Domain project has no package references
[Fact]
public void Domain_csproj_has_no_package_references()
{
    var csproj = XDocument.Load(Path.Combine(SolutionRoot, "src/Payments.Domain/Payments.Domain.csproj"));
    Assert.Empty(csproj.Descendants("PackageReference"));
}

[Fact]
public void Domain_types_have_no_framework_attributes() =>
    Assert.Empty(typeof(Payment).Assembly.GetTypes().SelectMany(t => t.GetProperties())
        .SelectMany(p => p.GetCustomAttributes(true)).Select(a => a.GetType().Namespace!)
        .Where(ns => ns.StartsWith("System.ComponentModel.DataAnnotations") || ns.StartsWith("System.Text.Json")));
~~~`,
  pts: [r`Gravity: attributes, framework types, serializer and ORM needs pulled inward.`, r`Fluent EF config, edge DTOs and application abstractions resist it.`, r`Architecture tests on namespaces, attributes and package references.`, r`Review checklist for inward framework concepts.`, r`Explicitly accepted low-level abstractions, written down.`],
  ex: r`A domain model gained JSON attributes for an API, then EF attributes for a migration, then lazy-loading proxies; two years later domain unit tests needed a database. A cleanup sprint plus three architecture tests restored millisecond domain tests.`,
  fu: [r`Is IOptions<T> acceptable in Application?`, r`How do you serialise value objects in APIs without attributes?`, r`What about domain types shared with a Blazor client?`],
  pit: [r`Data annotations in the domain.`, r`Framework types in use-case signatures.`, r`Public setters added for serializers.`] },

{ id: 'q28', level: 'Senior', tags: ['clean-architecture', 'caching', 'decorators', 'hybridcache'],
  q: r`Where does caching belong in Clean Architecture? Show caching as a decorator on ports, output caching at the edge, and caching query results, with invalidation that stays correct.`,
  a: r`### Placement options
| Where | What | Notes |
|---|---|---|
| **Edge** (output caching, HTTP caching headers) | whole responses for public or per-user GETs | simplest; invalidation by tags; never for writes |
| **Query side** | results of query ports (dashboards, reference lists) | decorator on the query port; per-tenant keys |
| **Driven adapters** | results of external calls (FX rates, BIN data, vendor lookups) | **decorator** implementing the same port; stampede protection |
| **Domain** | never | aggregates must load current state for invariants |

### Decorators keep the core unaware
{{CachedFxRates : IFxRates}} wraps {{HttpFxRates : IFxRates}}; registration decides. Use cases do not know whether a call is cached.

### Correctness
- Do not cache data used for **write decisions** where staleness breaks invariants (balances, limits), unless the authoritative check happens elsewhere.
- **Invalidate** on changes via domain/integration events (after commit), with versioned keys or tags; TTL as a safety net.
- Include tenant and user scope in keys.
- **Stampede protection**: HybridCache (.NET 9) or single-flight.`,
  code: r`~~~csharp
// Port and a caching decorator in Infrastructure
public interface IFxRates { Task<decimal> RateAsync(string pair, DateOnly on, CancellationToken ct); }

internal sealed class CachedFxRates(IFxRates inner, HybridCache cache) : IFxRates
{
    public async Task<decimal> RateAsync(string pair, DateOnly on, CancellationToken ct) =>
        await cache.GetOrCreateAsync($"fx:{pair}:{on:yyyyMMdd}",
            async token => await inner.RateAsync(pair, on, token),
            new HybridCacheEntryOptions { Expiration = on < DateOnly.FromDateTime(DateTime.UtcNow) ? TimeSpan.FromDays(30) : TimeSpan.FromMinutes(1) },
            cancellationToken: ct);                                   // historical rates are immutable: cache long
}
builder.Services.AddHttpClient<HttpFxRates>();
builder.Services.AddScoped<IFxRates>(sp => new CachedFxRates(sp.GetRequiredService<HttpFxRates>(), sp.GetRequiredService<HybridCache>()));

// Edge: output cache for a query endpoint, invalidated by tag after writes
app.MapGet("/merchants/{id}/fee-schedule", GetFeeSchedule).CacheOutput(p => p.Tag("fees").Expire(TimeSpan.FromMinutes(10)));
public sealed class FeeScheduleChangedHandler(IOutputCacheStore store) : IDomainEventHandler<FeeScheduleChanged>
{
    public async Task Handle(FeeScheduleChanged e, CancellationToken ct) => await store.EvictByTagAsync("fees", ct);
}
~~~`,
  pts: [r`Cache at the edge, on query ports or on driven adapters; never in the domain.`, r`Decorators keep use cases unaware of caching.`, r`No stale caches for write decisions.`, r`Invalidate via events with tags or versioned keys; TTL as a safety net.`, r`Scope keys by tenant/user; protect against stampedes.`],
  ex: r`A team cached account balances inside a use case to speed up transfers; a stale balance allowed overdrafts during a burst. Removing the cache from the write path and caching only statement queries kept speed and correctness.`,
  fu: [r`How do you invalidate caches across pods?`, r`What should be cached for a multi-tenant API?`, r`How do you test a caching decorator?`],
  pit: [r`Caching inside domain or write paths.`, r`Keys without tenant scope.`, r`Invalidation before commit.`] },

{ id: 'q29', level: 'Senior', tags: ['clean-architecture', 'feature-flags', 'versioning', 'evolution'],
  q: r`How do feature flags and API versioning interact with Clean Architecture? Where do flags get evaluated, how do you version use cases and endpoints, and how do you avoid flag debt in the core?`,
  a: r`### Flags
- **Release toggles** (hide unfinished work): evaluated at the **edge** (route available or not) or in the composition root (which adapter is wired).
- **Implementation switches** (new provider, new algorithm): select an **adapter or policy** via DI or a routing adapter; the use case stays unaware.
- **Business toggles** (feature per tenant/plan): an application port ({{IFeatureAccess}}) checked in the use case, because it is a product rule.
- **Experiments**: edge or policy selection with assignment logged for analysis.

### Avoid flags in the domain
Domain code with {{if (flags.IsEnabled(...))}} becomes untestable combinations. Express variants as policies or separate use cases; the flag only chooses which one.

### API versioning
- Versions are an **edge concern**: v1 and v2 endpoints map different contracts to the **same** use cases where possible.
- When behaviour differs, introduce a new use case (or a parameter with business meaning), not a version number inside the application layer.
- Keep old versions until consumers migrate; track usage per version.

### Flag hygiene
Each flag has an owner, type, expiry date, and removal ticket; CI or a dashboard lists stale flags; removing a flag deletes the losing branch.`,
  code: r`~~~csharp
// Implementation switch: chosen in the composition root via a routing adapter
builder.Services.AddScoped<IRefundGateway>(sp =>
{
    var flags = sp.GetRequiredService<IFeatureManager>();
    return flags.IsEnabledAsync("refunds-via-adyen").GetAwaiter().GetResult()
        ? sp.GetRequiredService<AdyenRefundGateway>()
        : sp.GetRequiredService<StripeRefundGateway>();
});

// Business toggle: a product rule checked in the use case through a port
if (!await features.HasAsync(tenant.TenantId, Feature.InstantPayouts, ct)) return Result.Forbidden<PayoutResult>("feature.not_in_plan");

// API versions map different contracts to the same use case
var v1 = app.MapGroup("/v1/refunds");
v1.MapPost("/", (RefundRequestV1 r, IHandler<IssueRefund, Result<RefundResult>> h, CancellationToken ct) =>
    h.Handle(r.ToCommand(reason: RefundReason.Unspecified), ct));
var v2 = app.MapGroup("/v2/refunds");
v2.MapPost("/", (RefundRequestV2 r, IHandler<IssueRefund, Result<RefundResult>> h, CancellationToken ct) =>
    h.Handle(r.ToCommand(), ct));                                   // v2 requires an explicit reason
~~~`,
  pts: [r`Release toggles at the edge or composition root.`, r`Implementation switches select adapters or policies.`, r`Business toggles are product rules checked via a port in use cases.`, r`No flags inside domain logic.`, r`API versions map contracts to the same use cases; flags have owners and expiry.`],
  ex: r`A payments core accumulated 140 flags, many checked inside domain methods; a test matrix explosion meant several combinations had never run until production. A flag cleanup moved switches to adapter selection and removed 90 expired flags.`,
  fu: [r`How do you test both sides of a flag?`, r`Where do per-tenant entitlements live?`, r`How do you deprecate an API version safely?`],
  pit: [r`Flags in domain methods.`, r`Version numbers inside use cases.`, r`Flags without expiry.`] },

{ id: 'q30', level: 'Senior', tags: ['clean-architecture', 'observability', 'opentelemetry', 'logging'],
  q: r`Add observability (traces, metrics, structured logs, audit) to a Clean Architecture service without polluting the domain. What is instrumented where?`,
  a: r`### By ring
| Ring | Instrumentation |
|---|---|
| **Edge / adapters** | automatic HTTP, EF Core/SqlClient, HttpClient and messaging instrumentation (OpenTelemetry) |
| **Use cases** | one span per use case via a pipeline decorator (name, outcome, error code), business metrics (refunds issued, amount), structured logs with ids |
| **Domain** | nothing directly; domain events carry the facts, and handlers or decorators turn them into metrics and audit records |
| **Infrastructure adapters** | dependency metrics (latency, failures, breaker state), vendor request ids |

### Why not in the domain
Logging calls inside aggregates add a dependency, noise and side effects to pure logic. Domain events are already a structured record of what happened.

### Audit
Regulatory audit is a **business requirement**: model it explicitly (audit records written from events in the same transaction or via outbox), not as log lines that may be sampled or lost.

### Practical rules
- {{System.Diagnostics.ActivitySource}} and {{Meter}} are part of the BCL, acceptable in Application.
- Use cases log **business identifiers** (payment id, merchant id), never PII or card data.
- One correlation id from edge to outbox messages (W3C trace context in message headers).`,
  code: r`~~~csharp
public sealed class TracingDecorator<TC, TR>(IHandler<TC, TR> inner) : IHandler<TC, TR>
{
    private static readonly ActivitySource Source = new("Payments.Application");
    private static readonly Counter<long> Outcomes = new Meter("Payments.Application").CreateCounter<long>("usecase.outcomes");

    public async Task<TR> Handle(TC cmd, CancellationToken ct)
    {
        using var activity = Source.StartActivity(typeof(TC).Name);
        try
        {
            var result = await inner.Handle(cmd, ct);
            var outcome = result is IResult r && r.IsFailure ? r.ErrorCode : "ok";
            activity?.SetTag("usecase.outcome", outcome);
            Outcomes.Add(1, new("usecase", typeof(TC).Name), new("outcome", outcome));
            return result;
        }
        catch (Exception ex) { activity?.SetStatus(ActivityStatusCode.Error, ex.GetType().Name); throw; }
    }
}

// Business metrics and audit from domain events, not from inside aggregates
public sealed class RefundMetricsHandler : IDomainEventHandler<RefundConfirmed>
{
    private static readonly Histogram<double> RefundAmount = new Meter("Payments.Business").CreateHistogram<double>("refund.amount");
    public Task Handle(RefundConfirmed e, CancellationToken ct) { RefundAmount.Record((double)e.Amount.Amount, new KeyValuePair<string, object?>("currency", e.Amount.Currency)); return Task.CompletedTask; }
}

builder.Services.AddOpenTelemetry()
    .WithTracing(t => t.AddSource("Payments.Application").AddAspNetCoreInstrumentation().AddEntityFrameworkCoreInstrumentation().AddHttpClientInstrumentation())
    .WithMetrics(m => m.AddMeter("Payments.Application", "Payments.Business"));
~~~`,
  pts: [r`Automatic instrumentation at adapters; a span and outcome metrics per use case.`, r`No logging inside the domain; events carry the facts.`, r`Audit is a modelled business requirement, not logs.`, r`ActivitySource and Meter are acceptable BCL dependencies.`, r`Business ids in logs, no PII; trace context through messages.`],
  ex: r`A team logged inside aggregates with an injected ILogger; tests needed logger mocks everywhere and PII leaked into logs from ToString overrides. Moving to a tracing decorator plus event-driven metrics removed both problems and gave per-use-case dashboards.`,
  fu: [r`How do you propagate trace context through the outbox?`, r`Which business metrics would you alert on?`, r`How do you keep audit records tamper-evident?`],
  pit: [r`Loggers injected into entities.`, r`Audit implemented as log lines.`, r`PII in traces.`] },

{ id: 'q31', level: 'Senior', tags: ['clean-architecture', 'full-stack', 'openapi', 'angular', 'react'],
  q: r`Full-stack: how do API contracts flow from a Clean Architecture .NET backend to Angular/React front ends? Where do contract DTOs live, how are clients generated, and how do you evolve them without breaking UIs?`,
  a: r`### Contracts belong to the outer ring
Request/response DTOs are part of the **API adapter**, separate from application commands and domain types. They are the published language for front ends and partners.

### Generation pipeline
1. ASP.NET Core produces **OpenAPI** (built-in {{Microsoft.AspNetCore.OpenApi}} in .NET 9) from endpoints and DTOs.
2. CI publishes the OpenAPI document as an artefact.
3. Front ends generate typed clients (NSwag, openapi-typescript, Orval, Kiota) as part of their build.
4. A **breaking-change check** (oasdiff or similar) runs on every backend PR against the last released spec.

### Design rules for UI-friendly contracts
- Stable, explicit shapes; enums as strings; money as decimal + currency (or strings for precision); dates in ISO 8601 UTC.
- ProblemDetails with stable error codes the UI can map to messages and field errors.
- Pagination with cursors; ETags for concurrency.
- Additive evolution; new required fields only in a new version.

### BFF
For complex UIs, a **Backend for Frontend** is another primary adapter (or a separate service) shaping responses for one UI and aggregating calls; it must not contain business rules.

### Frontend architecture
Angular/React apps mirror the idea: generated API clients as adapters, UI components free of HTTP details, state management in between.`,
  code: r`~~~csharp
// Api project: contracts are adapter types, documented for clients
public sealed record RefundResponse(Guid RefundId, string Status, decimal Amount, string Currency, DateTimeOffset CreatedAt);
builder.Services.AddOpenApi();
app.MapOpenApi();                                               // /openapi/v1.json
~~~
~~~yaml
# CI: publish spec and block breaking changes
- run: dotnet build && dotnet run --project src/Payments.Api -- --export-openapi artifacts/openapi.json
- run: oasdiff breaking https://api-specs.internal/payments/latest.json artifacts/openapi.json --fail-on ERR
~~~
~~~typescript
// Front end: generated, typed client used by a service; components never call fetch directly
import createClient from "openapi-fetch";
import type { paths } from "./generated/payments";

const api = createClient<paths>({ baseUrl: "/api" });

export async function issueRefund(paymentId: string, amount: number, currency: string, reason: string) {
  const { data, error } = await api.POST("/v2/payments/{paymentId}/refunds", {
    params: { path: { paymentId } },
    body: { amount, currency, reason },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  if (error) throw new ApiError(error.code, error.title);   // ProblemDetails with stable code
  return data;
}
~~~`,
  pts: [r`API DTOs are outer-ring contracts, separate from commands and domain types.`, r`OpenAPI from the backend; generated typed clients in front ends.`, r`Breaking-change checks on every backend PR.`, r`UI-friendly conventions: string enums, money with currency, ProblemDetails codes.`, r`BFFs are adapters without business rules.`],
  ex: r`A React team hand-wrote API types; a backend rename of "amount" to "grossAmount" broke the checkout page in production. Generated clients plus an oasdiff check in backend CI turned that kind of change into a failing PR.`,
  fu: [r`How do you handle money precision in JavaScript?`, r`When is a BFF worth a separate deployable?`, r`How do you share validation rules with the UI?`],
  pit: [r`Domain types as API contracts.`, r`Hand-written client types.`, r`Breaking changes without versioning.`] },

{ id: 'q32', level: 'Senior', tags: ['clean-architecture', 'modular-monolith', 'modules'],
  q: r`Apply Clean Architecture inside a modular monolith with several bounded contexts: per-module rings, cross-module communication, shared infrastructure, and avoiding a giant shared "Core" project.`,
  a: r`### Structure
Each module is a mini Clean Architecture: {{Module.Domain}}, {{Module.Application}}, {{Module.Infrastructure}}, plus a {{Module.Contracts}} project (public API and integration events). One host project composes all modules.

### Cross-module rules
- Modules depend only on other modules' **Contracts** (interfaces, DTOs, events).
- Synchronous calls through a public module API ({{IBillingModule}}), implemented internally.
- Asynchronous via in-process integration events with an outbox per module (same patterns as microservices).
- Separate schemas and DbContexts per module.

### Shared infrastructure
Shared **technical** building blocks (outbox implementation, messaging abstractions, auth, telemetry) in a **BuildingBlocks** package with no business concepts. Shared **business** concepts go into module contracts or a tiny shared kernel (Money), owned and versioned.

### The "Core" trap
A shared Core/Common project that every module references tends to accumulate business types, utilities and dependencies, coupling all modules. Rules: no domain types in BuildingBlocks; review additions; architecture tests forbidding module-to-module internal references.

### Benefits
One deployment, in-process calls, easy refactoring between modules, and a clear path to extracting a module into a service later.`,
  code: r`~~~text
src/
  Host/                         Program.cs: AddBillingModule(), AddLedgerModule(), AddPaymentsModule()
  BuildingBlocks/               Outbox, Inbox, IEventBus, Result, telemetry (no business types)
  Modules/
    Payments/  Payments.Domain  Payments.Application  Payments.Infrastructure  Payments.Contracts
    Billing/   Billing.Domain   Billing.Application   Billing.Infrastructure   Billing.Contracts
    Ledger/    Ledger.Domain    Ledger.Application    Ledger.Infrastructure    Ledger.Contracts
~~~
~~~csharp
// Billing.Contracts: the only thing Payments may reference
public interface IBillingModule { Task<InvoiceSummaryDto?> GetInvoiceAsync(Guid invoiceId, CancellationToken ct); }
public sealed record InvoicePaidV1(Guid InvoiceId, decimal Amount, string Currency, DateTimeOffset PaidAt);

// Architecture test: Payments must not reference Billing internals
[Fact]
public void Payments_only_uses_billing_contracts() =>
    Assert.True(Types.InAssembly(typeof(Payments.Application.Marker).Assembly)
        .ShouldNot().HaveDependencyOnAny("Billing.Domain", "Billing.Application", "Billing.Infrastructure")
        .GetResult().IsSuccessful);

// BuildingBlocks must stay free of business concepts
[Fact]
public void BuildingBlocks_has_no_module_dependencies() =>
    Assert.True(Types.InAssembly(typeof(BuildingBlocks.Outbox.OutboxMessage).Assembly)
        .ShouldNot().HaveDependencyOnAny("Payments", "Billing", "Ledger").GetResult().IsSuccessful);
~~~`,
  pts: [r`Each module is a mini Clean Architecture plus a Contracts project.`, r`Cross-module: contracts, public module APIs, in-process events with outbox.`, r`Schema and DbContext per module.`, r`BuildingBlocks hold technical code only; avoid a business "Core".`, r`Architecture tests keep modules honest; extraction stays easy.`],
  ex: r`A modular monolith's Shared.Core project grew to 400 types including Customer, Invoice and Payment DTOs used everywhere; any change rebuilt and retested every module. Splitting it into BuildingBlocks plus per-module contracts cut CI time by 60%.`,
  fu: [r`How do you run integration tests per module?`, r`When would you extract a module into a service?`, r`How do you handle a transaction that spans two modules?`],
  pit: [r`A shared business Core project.`, r`Cross-module database joins.`, r`Modules referencing each other's Application layers.`] },

{ id: 'q33', level: 'Senior', tags: ['clean-architecture', 'serverless', 'azure-functions', 'aws-lambda'],
  q: r`Does Clean Architecture fit serverless (Azure Functions, AWS Lambda)? How do functions act as primary adapters, what changes for cold starts, DI and scopes, and when is the full structure too heavy?`,
  a: r`### Functions as primary adapters
A function trigger (HTTP, queue, timer, blob) is a **driving adapter**: deserialize, build a command, call the use case, map the result. The same Application and Domain projects can serve a function app, a web API and a worker.

### What changes
- **Cold starts**: large DI graphs, reflection-based scanning (mediators, AutoMapper) and EF model building add latency. Mitigations: source-generated DI and mediators, compiled EF models, trimming/ReadyToRun, keeping the function app focused on a few use cases.
- **Scopes**: isolated worker model provides a scope per invocation; ensure scoped services (DbContext) are not captured by singletons.
- **Connections**: many concurrent instances × pool size can exhaust database connections; set pool caps or use a proxy.
- **Idempotency**: triggers deliver at least once; use cases must be idempotent.
- **Timeouts**: long use cases must be split (durable orchestrations for workflows).

### When to simplify
Small, single-purpose functions (resize an image, forward a webhook) do not need rings; a handler file is enough. Use the full structure when the function app hosts real domain logic shared with other entry points.`,
  code: r`~~~csharp
// Azure Functions isolated worker: trigger as a thin primary adapter
public sealed class RefundFunctions(IHandler<IssueRefund, Result<RefundResult>> issueRefund)
{
    [Function("IssueRefundFromQueue")]
    public async Task Run([ServiceBusTrigger("refund-requests", Connection = "Bus")] RefundRequestedV1 msg, CancellationToken ct)
    {
        var result = await issueRefund.Handle(msg.ToCommand(), ct);              // idempotent by msg.RequestId
        if (result.IsFailure && result.Error!.Kind == ErrorKind.Rule) return;     // business rejection: complete the message
    }

    [Function("IssueRefundHttp")]
    public async Task<IActionResult> Http([HttpTrigger(AuthorizationLevel.Function, "post", Route = "payments/{id:guid}/refunds")] HttpRequest req, Guid id, CancellationToken ct)
    {
        var body = await req.ReadFromJsonAsync<IssueRefundRequest>(ct);
        var result = await issueRefund.Handle(body!.ToCommand(id), ct);
        return result.ToActionResult();
    }
}

// Program.cs: same AddApplication/AddInfrastructure as the web API, tuned for cold start
var host = new HostBuilder()
    .ConfigureFunctionsWebApplication()
    .ConfigureServices((ctx, s) =>
    {
        s.AddApplication();
        s.AddInfrastructure(ctx.Configuration);          // compiled EF model, pool cap in connection string
    })
    .Build();
host.Run();
~~~`,
  pts: [r`Triggers are driving adapters calling the same use cases.`, r`Cold starts: avoid reflection-heavy libraries, use compiled models and source generators.`, r`Watch connection pools across many instances.`, r`Triggers are at-least-once: idempotent use cases.`, r`Tiny single-purpose functions do not need rings.`],
  ex: r`A team moved refund processing to Azure Functions reusing their Application project; cold starts of 6 seconds came from AutoMapper and MediatR assembly scanning. Source-generated alternatives and a compiled EF model brought cold start to 1.2 seconds.`,
  fu: [r`How do durable orchestrations relate to use cases?`, r`How do you limit database connections from scaled-out functions?`, r`When is a function app better split into several?`],
  pit: [r`Business logic in function bodies.`, r`Reflection-heavy startup.`, r`Non-idempotent queue-triggered use cases.`] },

{ id: 'q34', level: 'Senior', tags: ['clean-architecture', 'n-tier', 'refactoring', 'migration'],
  q: r`Migrate a classic N-tier .NET app (Controller → Service → Repository → EF, with logic in services and EF entities everywhere) towards Clean Architecture incrementally, without a rewrite.`,
  a: r`### Where N-tier usually is
- Dependencies point **downward to data access**: services depend on repositories and EF entities; the "business layer" depends on the database.
- Logic in services; entities anemic; EF types everywhere, including controllers.

### Incremental path
1. **Characterisation tests** around critical flows (API-level with a real database) to protect behaviour.
2. **Invert the first dependency**: define repository/gateway interfaces in the business layer (ports) and move implementations into an Infrastructure project. Now data access depends on the business layer.
3. **Extract use cases** from fat services one operation at a time (keep the service as a facade delegating to them until callers move).
4. **Move rules into the domain**: as you touch a use case, push its business conditions into entity methods and value objects; make setters private.
5. **Introduce DTOs at the edge** for endpoints that return entities.
6. **Architecture tests** for the boundaries you have established, expanding over time.
7. Apply the full structure only to complex areas; simple CRUD stays simple.

### Organisational side
Prioritise by pain (defects, change frequency); make each step a normal, shippable PR; track progress (architecture test coverage, number of use cases extracted).`,
  code: r`~~~csharp
// Before: service depends on EF directly, rules inside
public class LoanService(AppDbContext db)
{
    public async Task MakeOverpayment(int loanId, decimal amount)
    {
        var loan = await db.Loans.FindAsync(loanId);
        if (loan!.Status != "Active") throw new Exception("Inactive");
        if (loan.OverpaidThisYear + amount > loan.Balance * 0.1m) throw new Exception("Over 10%");
        loan.Balance -= amount; loan.OverpaidThisYear += amount;
        await db.SaveChangesAsync();
    }
}

// Step 2+3+4: port, use case, rule moved into the entity; old service becomes a facade
public interface ILoanRepository { Task<Loan?> GetAsync(LoanId id, CancellationToken ct); }
public sealed class MakeOverpaymentHandler(ILoanRepository loans, IUnitOfWork uow, TimeProvider clock)
{
    public async Task<Result> Handle(MakeOverpayment cmd, CancellationToken ct)
    {
        var loan = await loans.GetAsync(cmd.LoanId, ct);
        if (loan is null) return Result.NotFound();
        loan.Overpay(cmd.Amount, DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime));   // rule now in Loan
        await uow.SaveChangesAsync(ct);
        return Result.Ok();
    }
}
[Obsolete("Use MakeOverpaymentHandler; facade kept until controllers migrate (PLAT-221)")]
public class LoanServiceFacade(MakeOverpaymentHandler h)
{
    public Task MakeOverpayment(int loanId, decimal amount) => h.Handle(new MakeOverpayment(new LoanId(loanId), Money.Gbp(amount)), default);
}
~~~`,
  pts: [r`N-tier depends downward on data access; Clean inverts it.`, r`Characterisation tests first.`, r`Invert dependencies with ports, then extract use cases one at a time.`, r`Move rules into entities as you touch them; DTOs at the edge.`, r`Shippable steps prioritised by pain; full structure only where complex.`],
  ex: r`A lending platform's 9,000-line LoanService was split into 64 use cases over six months alongside feature work; defects in loan servicing dropped by a third and new developers could find an operation's code by name.`,
  fu: [r`How do you prioritise which service to break up first?`, r`What if the service methods share private helper logic?`, r`How do you keep the facade from living forever?`],
  pit: [r`Big-bang rewrite.`, r`Moving code into new projects without inverting dependencies.`, r`Refactoring without characterisation tests.`] },

{ id: 'q35', level: 'Senior', tags: ['clean-architecture', 'workflows', 'process-manager', 'durable'],
  q: r`Some business operations take days (loan origination with document checks and manual approval). How do you model long-running workflows in Clean Architecture: process managers, workflow engines, or durable functions, and where does each piece live?`,
  a: r`### The pieces
- **Workflow state and rules** (what step we are in, what may happen next, timeouts): business logic → Application/Domain as a **process manager** aggregate, or a workflow definition.
- **Steps**: ordinary use cases ({{RequestDocuments}}, {{RunCreditCheck}}, {{ApproveApplication}}).
- **Triggers**: events, user actions, timers: primary adapters that call the process manager.
- **Durable timers and persistence**: Infrastructure (database rows + scheduler, or an engine).

### Options
| Option | Pros | Cons |
|---|---|---|
| **Process manager in your code** (state in DB, outbox, scheduled timeouts) | full control, domain language, testable | you build timers, retries, visibility |
| **Workflow engine** (Temporal, Elsa, Camunda) | durable execution, visibility, retries, versioning | engine semantics leak (determinism rules), operational cost |
| **Durable Functions / Logic Apps** | serverless durable orchestration | platform coupling, versioning of in-flight orchestrations |

### Keeping the core clean
Whatever executes the workflow, keep **decisions** (eligibility, approval rules) in domain/use-case code that the workflow calls. The engine handles **durability and scheduling**, not business rules. Wrap engine APIs behind ports where feasible.

### Operational needs
Visibility of every instance (where is application 123?), manual intervention (retry, skip, cancel), versioning of in-flight instances when the process changes, and SLA timers.`,
  code: r`~~~csharp
// Process manager aggregate: state + transitions + timeouts, in the domain language
public sealed class OriginationProcess : AggregateRoot<ApplicationId>
{
    public OriginationStep Step { get; private set; } = OriginationStep.AwaitingDocuments;
    public DateTimeOffset DueBy { get; private set; }

    public IEnumerable<ICommand> OnDocumentsReceived(DateTimeOffset now)
    {
        if (Step != OriginationStep.AwaitingDocuments) yield break;
        Step = OriginationStep.CreditCheck; DueBy = now.AddHours(1);
        yield return new RunCreditCheck(Id);
    }

    public IEnumerable<ICommand> OnCreditChecked(CreditGrade grade, DateTimeOffset now)
    {
        if (Step != OriginationStep.CreditCheck) yield break;
        Step = grade.RequiresManualReview ? OriginationStep.ManualReview : OriginationStep.Approved;
        DueBy = now.AddDays(2);
        yield return grade.RequiresManualReview ? new AssignUnderwriter(Id) : new ApproveApplication(Id);
    }

    public IEnumerable<ICommand> OnTimeout(DateTimeOffset now)
    {
        if (now < DueBy) yield break;
        if (Step == OriginationStep.AwaitingDocuments) yield return new SendDocumentReminder(Id);
        if (Step == OriginationStep.ManualReview) yield return new EscalateReview(Id);
    }
}

// Infrastructure: timers as rows scanned by a scheduler; commands dispatched via the outbox
// SELECT Id FROM origination.Processes WHERE DueBy < SYSUTCDATETIME() AND Step NOT IN ('Approved','Declined')
~~~`,
  pts: [r`Workflow state and rules are business logic; steps are ordinary use cases.`, r`Durability and timers are infrastructure.`, r`Own process managers, workflow engines or durable functions: trade control vs features.`, r`Keep decisions out of engine code.`, r`Visibility, manual intervention and versioning of in-flight instances.`],
  ex: r`A lender's origination flow lived in a BPM tool with eligibility rules embedded in diagrams; rule changes needed a vendor specialist. Moving decisions into use cases called by the workflow made rule changes normal code changes, while the engine kept handling waits and reminders.`,
  fu: [r`How do you version a workflow with instances in flight?`, r`How do operators retry a failed step?`, r`Temporal's determinism rules: what do they imply for your code?`],
  pit: [r`Business rules inside workflow definitions.`, r`No visibility into instance state.`, r`Ignoring in-flight versioning.`] },

{ id: 'q36', level: 'Senior', tags: ['clean-architecture', 'configuration', 'secrets', 'environments'],
  q: r`Environment-specific behaviour (sandbox vs production payment provider, fake email in test, regional settings) and secrets: how do you keep them out of the core, wire them in the composition root, and avoid "if production" branches?`,
  a: r`### Principles
- The core never knows which environment it runs in.
- Environment differences are expressed as **different adapters** or **different configuration values**, chosen in the composition root.
- Secrets live in a secret store (Key Vault, Secrets Manager) or managed identities, loaded by the host, never in code or Application config classes.

### Patterns
- {{AddInfrastructure}} chooses adapters by configuration ({{Payments:Provider = Sandbox|Stripe}}), not by environment name checks scattered around.
- **Options classes** validated at startup ({{ValidateOnStart}}) so misconfiguration fails fast.
- Test/dev adapters ({{FakeEmailSender}}, {{SandboxGateway}}) live in Infrastructure or test projects and cannot be accidentally enabled in production (startup guard).
- Regional/tenant settings via application ports with cached infrastructure implementations.

### Avoid
- {{if (env.IsProduction())}} inside use cases or adapters.
- Secrets in appsettings committed to Git.
- Configuration read ad hoc with {{IConfiguration["..."]}} deep in the code.`,
  code: r`~~~csharp
public sealed class PaymentProviderOptions
{
    public required string Provider { get; init; }            // "Sandbox" | "Stripe" | "Adyen"
    public required Uri BaseUrl { get; init; }
}

public static IServiceCollection AddInfrastructure(this IServiceCollection s, IConfiguration cfg, IHostEnvironment env)
{
    s.AddOptions<PaymentProviderOptions>().Bind(cfg.GetSection("Payments")).ValidateDataAnnotations().ValidateOnStart();

    var provider = cfg["Payments:Provider"];
    if (env.IsProduction() && provider == "Sandbox")
        throw new InvalidOperationException("Sandbox payment provider is not allowed in production");   // startup guard, not runtime branches

    switch (provider)
    {
        case "Stripe":  s.AddHttpClient<IPaymentGateway, StripeGateway>().AddStandardResilienceHandler(); break;
        case "Adyen":   s.AddHttpClient<IPaymentGateway, AdyenGateway>().AddStandardResilienceHandler(); break;
        case "Sandbox": s.AddSingleton<IPaymentGateway, SandboxGateway>(); break;
        default: throw new InvalidOperationException($"Unknown provider {provider}");
    }
    return s;
}

// Secrets: Key Vault via managed identity, loaded by the host only
builder.Configuration.AddAzureKeyVault(new Uri(builder.Configuration["KeyVault:Uri"]!), new DefaultAzureCredential());
~~~`,
  pts: [r`The core is environment-agnostic.`, r`Environment differences = different adapters or values chosen in the composition root.`, r`Validate options at startup; guard against test adapters in production.`, r`Secrets from secret stores or managed identities, loaded by the host.`, r`No environment checks inside use cases or adapters.`],
  ex: r`A sandbox payment adapter was enabled in production by a copied config file and approved 600 payments that never reached the provider. A startup guard and options validation made that configuration fail the deployment instead.`,
  fu: [r`How do you rotate secrets without restarts?`, r`Where do per-region settings come from?`, r`How do you test the production wiring?`],
  pit: [r`if (IsProduction) branches in code.`, r`Secrets in repositories.`, r`Configuration read deep inside the core.`] },

{ id: 'q37', level: 'Principal', tags: ['clean-architecture', 'legacy', 'settlement', 'refactoring'],
  q: r`Capstone: a 10-year-old payment-settlement engine has business rules in stored procedures, WCF services calling SQL directly, no tests, and regulators require auditability. Lead its move to Clean Architecture without a rewrite.`,
  a: r`### Principles
Never big-bang; every step shippable and reversible; prove equivalence before switching; keep the business running and auditors satisfied.

### Plan
1. **Characterisation tests**: capture real historical inputs and the engine's outputs (settlement files, netting results) as golden files; run them in CI against every change.
2. **Map the rules**: read stored procedures with operations and finance; write the settlement rules (netting, cut-off times, currency handling, holidays) in the ubiquitous language.
3. **Extract a domain core**: implement those rules in a pure Domain project with value objects ({{Money}}, {{ValueDate}}, {{Iban}}, {{CutOff}}); unit and property-based tests.
4. **Ports**: {{ISettlementRepository}}, {{IBankGateway}}, {{IFxRates}}, {{TimeProvider}}.
5. **Adapters over legacy first**: implement ports by calling the existing stored procedures/tables (an ACL), so the new core runs on the old data.
6. **Parallel run**: new core computes settlements alongside the stored procedures; automated reconciliation of every batch; discrepancies triaged with finance (some are old bugs to preserve or fix by decision).
7. **Strangle entry points**: new API/CLI adapters call use cases; WCF becomes a thin adapter until clients migrate.
8. **Replace infrastructure** behind ports (EF Core, new schema) once the core is trusted.
9. **Fitness functions and audit**: architecture tests, audit records from use cases, change control evidence.

### Governance
Steering with finance and operations; metrics: discrepancy rate, change lead time, incidents; documented decisions (ADRs) for regulators.`,
  dia: r`flowchart LR
  WCF[WCF clients] --> WA[Thin WCF adapter]
  API[New API and CLI] --> UC[Settlement use cases]
  WA --> UC
  UC --> D[Domain: netting, cut-offs, FX]
  UC --> P[Ports]
  P --> LA[Legacy adapter: stored procedures]
  P --> NA[New adapter: EF Core schema]
  SP[Legacy stored procedures] -.->|parallel run| R[Reconciliation reports]
  UC -.-> R`,
  code: r`~~~csharp
// Golden-file characterisation test over real historical batches
[Theory, MemberData(nameof(HistoricalBatches))]
public async Task New_core_matches_legacy_output(string batchFile)
{
    var input = GoldenFiles.LoadInput(batchFile);
    var expected = GoldenFiles.LoadLegacyOutput(batchFile);
    var actual = await SettlementHarness.RunNewCoreAsync(input);
    SettlementAssert.Equivalent(expected, actual, tolerance: Money.Zero(input.Currency));   // exact for money
}

// Port implemented over legacy procedures first (anti-corruption)
internal sealed class LegacySettlementRepository(SqlConnection conn) : ISettlementRepository
{
    public async Task<SettlementBatch?> GetAsync(BatchId id, CancellationToken ct)
    {
        var rows = await conn.QueryAsync<LegacyBatchRow>("dbo.usp_GetSettlementBatch", new { BatchId = id.Value },
                                                         commandType: CommandType.StoredProcedure);
        return LegacyMapper.ToDomain(rows);
    }
}

// Reconciliation during parallel run
var diffs = Reconcile.Compare(legacyResult, newResult);
if (diffs.Any()) await diffStore.SaveAsync(batchId, diffs, ct);       // reviewed with finance daily
~~~`,
  pts: [r`Characterisation tests from real historical batches first.`, r`Extract rules into a pure domain with experts; ports for every dependency.`, r`Adapters over legacy procedures first; parallel run with reconciliation.`, r`Strangle entry points; replace infrastructure last.`, r`Governance with finance, ADRs and audit evidence.`],
  ex: r`A bank followed this path for its settlement engine over 14 months; the parallel run found 23 discrepancy types, 4 of which were legacy bugs the business chose to fix. After switch-over, rule changes went from quarterly releases to weekly ones with full regression in 8 minutes.`,
  fu: [r`How long should the parallel run last?`, r`What do you do with legacy bugs that clients depend on?`, r`How do you evidence the change to the regulator?`],
  pit: [r`Big-bang rewrite.`, r`Refactoring without golden files.`, r`Replacing infrastructure before the core is trusted.`] },

{ id: 'q38', level: 'Principal', tags: ['clean-architecture', 'standards', 'templates', 'platform'],
  q: r`Standardise architecture across 20 .NET services built by 8 teams without forcing ceremony on simple services. What templates, criteria and guardrails do you provide?`,
  a: r`### Two (or three) blessed shapes
| Template | For | Shape |
|---|---|---|
| **Simple service** | CRUD, integration glue, small APIs | one project, feature folders/vertical slices, minimal APIs, EF Core directly, shared ServiceDefaults |
| **Rich domain service** | complex, long-lived, rule-heavy core domains | Domain / Application / Infrastructure / Api projects, use cases, ports, architecture tests |
| (optional) **Modular monolith** | several related contexts owned by one or two teams | modules with contracts, BuildingBlocks |

### Selection criteria (decided in design review)
Business rule complexity, expected lifetime, number of entry points, regulatory needs, team size. Moving from simple to rich later must be possible (feature folders map onto use cases).

### Shared across all
- **ServiceDefaults** package: OpenTelemetry, health checks, resilience, ProblemDetails, auth, configuration validation.
- Error model, logging conventions, API guidelines, outbox/inbox building blocks.
- A small set of **org-wide architecture tests** shipped as a package (no framework types in Domain if a Domain exists; no secrets in config; endpoints do not use DbContext in rich services).

### Governance
- {{dotnet new}} templates maintained by the platform team with real examples.
- Architecture decision records for deviations.
- Periodic review of template fit; measure lead time and onboarding.

### What not to do
One mandatory 8-project template for everything; reviewers rejecting simple services for "not being Clean".`,
  code: r`~~~bash
# Templates published by the platform team
dotnet new install Company.Templates::3.4.0
dotnet new company-simple-api  -n Catalog.Api
dotnet new company-rich-domain -n Payments --with-outbox --with-architecture-tests
~~~
~~~csharp
// ServiceDefaults shared by every template
public static class ServiceDefaults
{
    public static IHostApplicationBuilder AddCompanyDefaults(this IHostApplicationBuilder b)
    {
        b.Services.AddProblemDetails();
        b.Services.AddHealthChecks();
        b.Services.ConfigureHttpClientDefaults(h => h.AddStandardResilienceHandler());
        b.Services.AddOpenTelemetry().WithTracing(t => t.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation())
                                     .WithMetrics(m => m.AddAspNetCoreInstrumentation().AddRuntimeInstrumentation());
        b.Services.AddOptions<CompanyAuthOptions>().BindConfiguration("Auth").ValidateOnStart();
        return b;
    }
}

// Org-wide architecture rules package, applied conditionally
public abstract class CompanyArchitectureRules(Assembly? domain, Assembly api)
{
    [Fact] public void Domain_is_framework_free() { if (domain is not null) ArchRules.DomainFrameworkFree(domain); }
    [Fact] public void No_secrets_in_appsettings() => ArchRules.NoSecretsInConfig(api);
}
~~~`,
  pts: [r`Two or three blessed shapes, chosen by explicit criteria.`, r`Shared ServiceDefaults for cross-cutting concerns.`, r`Org-wide architecture tests as a package, applied proportionally.`, r`Templates with real examples; ADRs for deviations.`, r`Never one heavy template for everything.`],
  ex: r`A payments group mandated an 8-project template; simple integration services took weeks to build and teams quietly bypassed the rules. Introducing a simple template alongside the rich one, with selection criteria, halved time-to-first-deploy for new services while core services kept their boundaries.`,
  fu: [r`How do you upgrade templates across existing services?`, r`Who decides which template a service uses?`, r`How do you measure whether the standards help?`],
  pit: [r`One template for every service.`, r`Standards without tooling.`, r`Ignoring deviations instead of recording them.`] },

{ id: 'q39', level: 'Principal', tags: ['clean-architecture', 'cost', 'trade-offs', 'leadership'],
  q: r`What does Clean Architecture cost an organisation, how do you decide whether a given system should pay it, and how do you explain the decision to executives?`,
  a: r`### Costs
- **Code and indirection**: more projects, interfaces, mapping; more files per change.
- **Onboarding**: newcomers must learn the conventions; "where does this request go?".
- **Build and CI time**: more projects, more tests.
- **Design effort**: ports and use cases must be designed well or they become leaky ceremony.
- **Performance pitfalls** if applied naively (reads through repositories, chatty ports).

### Benefits (where they materialise)
- Business rules testable in milliseconds → faster, safer change.
- Infrastructure replaceable behind ports (providers, databases, delivery mechanisms).
- Multiple entry points share one behaviour.
- Auditability: use cases as the single place where operations happen.

### Decision factors
| Factor | Pushes towards Clean |
|---|---|
| business rule complexity | high |
| expected lifetime | 5+ years |
| entry points | several (API, events, jobs) |
| external dependencies likely to change | yes |
| regulatory scrutiny | high |
| team size and turnover | larger teams benefit from enforced boundaries |

### Explaining to executives
Talk in outcomes: lead time for rule changes, defect rates, cost of switching a provider, audit readiness. "We invest X% more initial effort in the payments core to cut change lead time and provider lock-in; we do not do this for internal tools."`,
  code: r`~~~text
Decision record excerpt (ADR-0087): architecture style for "Merchant Fees" service

Context:   ~60 fee rules, 4 entry points (API, settlement events, monthly job, back-office tool),
           2 payment providers planned, PCI/finance audit, expected life 8+ years.
Decision:  Rich domain template (Clean Architecture + use cases + ports + architecture tests).
Rejected:  Simple template - rules would spread across endpoints, jobs and consumers.
Costs:     ~15% more initial effort; 4 projects; onboarding guide required.
Success:   rule-change lead time < 3 days; zero fee defects escaping to production per quarter;
           provider switch possible by adding one adapter.
Review:    after 6 months against these metrics.
~~~
~~~csharp
// The payoff: a fee rule change is a domain change with millisecond tests
[Theory]
[InlineData("Gold", "Card", 100.00, 1.20)]
[InlineData("Standard", "Card", 100.00, 1.80)]
public void Fee_schedule_2026_q4(string tier, string method, decimal amount, decimal expectedFee) =>
    Assert.Equal(expectedFee, FeeSchedules.Q4_2026.FeeFor(Enum.Parse<MerchantTier>(tier), Enum.Parse<PaymentMethod>(method), Money.Gbp(amount)).Amount);
~~~`,
  pts: [r`Costs: indirection, onboarding, build time, design effort, naive performance traps.`, r`Benefits: fast rule tests, replaceable infrastructure, shared behaviour across entry points, auditability.`, r`Decide by rule complexity, lifetime, entry points, volatility, regulation, team size.`, r`Record decisions with success metrics and review dates.`, r`Explain in business outcomes, not patterns.`],
  ex: r`An executive challenged why the platform team's internal tools took longer than a startup competitor's; the review showed they used the rich template everywhere. Restricting it to five core services and simplifying 14 others cut delivery time on tools by 40% without touching the core's quality.`,
  fu: [r`How do you measure whether the investment paid off?`, r`What if a simple service grows complex?`, r`How do you handle teams that want the rich template for status reasons?`],
  pit: [r`Applying it uniformly.`, r`Justifying it with pattern names instead of outcomes.`, r`No review of the decision.`] },

{ id: 'q40', level: 'Principal', tags: ['clean-architecture', 'design-review', 'architecture'],
  q: r`Design review: a team proposes a new "Payouts" service with 9 projects, a generic repository, AutoMapper everywhere, MediatR notifications for every side effect, and a shared Common project with other services. What feedback do you give?`,
  a: r`### Questions first
- What are the business rules (payout eligibility, reserves, netting, cut-offs)? How complex, how volatile?
- Which entry points (API, settlement events, scheduled runs)?
- Which external dependencies (banks, ledger)?
- Who owns the service and for how long?

### Feedback
1. **Project count**: 9 projects need justification; start with Domain, Application, Infrastructure, Api (+ Contracts for published events). Merge the rest.
2. **Generic repository**: replace with aggregate-specific repositories; queries via query ports or projections. Generic repositories leak IQueryable and allow partial aggregates.
3. **AutoMapper everywhere**: mapping only at edges, manual or source-generated with compile-time checks; no mapping between identical shapes.
4. **MediatR notifications for side effects**: hidden coupling and in-process, non-durable delivery. Use domain events → outbox → idempotent handlers for anything that matters (bank instructions, ledger postings, emails).
5. **Shared Common project**: coupling to other services' release cycles; use versioned packages for technical building blocks only, published contracts for integration.
6. **Missing**: idempotency for payout commands, intent/act/outcome for bank calls, reconciliation with the ledger, architecture tests, error model.

### Outcome
A short written review with must-fix items (outbox, idempotency, Common project) and suggestions (project count, mapping), plus an offer to pair on the first use case.`,
  code: r`~~~csharp
// Instead of a MediatR notification fan-out on PayoutScheduled...
// await mediator.Publish(new PayoutScheduledNotification(...));   // in-process, lost on crash, hidden handlers

// ...domain event -> outbox -> idempotent handlers
public sealed class Payout : AggregateRoot<PayoutId>
{
    public void Schedule(BankAccount destination, Money amount, DateOnly valueDate)
    {
        /* eligibility and reserve rules */
        Raise(new PayoutScheduled(Id, destination, amount, valueDate));
    }
}
public sealed class SubmitPayoutToBank(IBankGateway bank, IPayoutRepository payouts, IUnitOfWork uow) : IDomainEventHandler<PayoutScheduled>
{
    public async Task Handle(PayoutScheduled e, CancellationToken ct)
    {
        var ack = await bank.SubmitAsync(e.Destination, e.Amount, e.ValueDate, idempotencyKey: e.PayoutId.ToString(), ct);
        var payout = await payouts.GetAsync(e.PayoutId, ct);
        payout!.MarkSubmitted(ack.Reference);
        await uow.SaveChangesAsync(ct);
    }
}

// Aggregate repository instead of IRepository<T>
public interface IPayoutRepository { Task<Payout?> GetAsync(PayoutId id, CancellationToken ct); void Add(Payout p); }
~~~`,
  pts: [r`Ask about rules, entry points, dependencies and ownership before judging structure.`, r`Trim projects; aggregate repositories; edge-only mapping.`, r`Outbox-backed events instead of in-process notifications for important side effects.`, r`No shared business Common project between services.`, r`Separate must-fix items from suggestions; offer to pair.`],
  ex: r`A payouts service reviewed this way shipped with an outbox and idempotent bank submissions; six months later a bank API outage caused retries of 12,000 payouts with zero duplicates, while a sibling service built with in-process notifications lost 300 instructions in a similar incident.`,
  fu: [r`How do you give this feedback without demotivating the team?`, r`Which items would you block the launch on?`, r`How do you follow up after the review?`],
  pit: [r`Reviewing patterns without understanding the domain.`, r`Blocking on style preferences.`, r`Missing the reliability gaps behind the structural ones.`] },

{ id: 'q41', level: 'Principal', tags: ['clean-architecture', 'code-review'],
  q: r`Code review: identify the Clean Architecture and reliability problems in this use case and propose a corrected version.`,
  a: r`~~~csharp
namespace Payouts.Application;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Http;

public class SchedulePayoutHandler(PayoutsDbContext db, IHttpContextAccessor http, HttpClient bank, IMediator mediator)
{
    public async Task<IResult> Handle(Guid merchantId)
    {
        var merchant = await db.Merchants.Include(m => m.Transactions).FirstAsync(m => m.Id == merchantId);
        var balance = merchant.Transactions.Sum(t => t.Amount) - merchant.Reserve;
        if (balance <= 0) return Results.BadRequest("Nothing to pay");
        if (DateTime.Now.Hour >= 16) return Results.BadRequest("After cut-off");
        var payout = new Payout { MerchantId = merchantId, Amount = balance, CreatedBy = http.HttpContext!.User.Identity!.Name };
        db.Payouts.Add(payout);
        await db.SaveChangesAsync();
        var resp = await bank.PostAsJsonAsync("https://bank/payments", new { iban = merchant.Iban, amount = balance });
        payout.Status = resp.IsSuccessStatusCode ? "Sent" : "Failed";
        await db.SaveChangesAsync();
        await mediator.Publish(new PayoutDone(payout.Id));
        return Results.Ok(payout);
    }
}
~~~

Findings:
1. **Dependency Rule**: Application uses EF Core ({{DbContext}}, {{Include}}), ASP.NET Core ({{IHttpContextAccessor}}, {{IResult}}) and a raw {{HttpClient}}: no ports.
2. **Business rules in the handler** (available balance, cut-off) instead of the domain; computed by loading **all transactions** (huge aggregate, slow).
3. **{{DateTime.Now}}**: local time, untestable; cut-off needs a time zone and business calendar.
4. **Bank call**: no idempotency key; failure after the first save leaves a "Failed" payout although the bank might have accepted it (timeout); no recovery.
5. **Concurrency**: two requests can schedule two payouts for the same balance (no reservation, no version).
6. **Returns the entity** and HTTP results from Application.
7. **In-process notification** after commit: lost on crash.
8. {{CreatedBy}} from HttpContext: breaks for jobs and consumers.
9. Money as decimal without currency; hard-coded URL.`,
  code: r`~~~csharp
namespace Payouts.Application;

public sealed record SchedulePayout(MerchantId MerchantId, Guid RequestId);

public sealed class SchedulePayoutHandler(
    IMerchantBalanceRepository balances, IPayoutRepository payouts, IBusinessCalendar calendar,
    ICurrentUser user, IUnitOfWork uow, TimeProvider clock)
{
    public async Task<Result<PayoutScheduledResult>> Handle(SchedulePayout cmd, CancellationToken ct)
    {
        var balance = await balances.GetAsync(cmd.MerchantId, ct);                         // small aggregate, versioned
        if (balance is null) return Result.NotFound<PayoutScheduledResult>("merchant.not_found");

        var valueDate = calendar.NextPayoutDate(clock.GetUtcNow());                         // cut-off rules in a domain service
        var payout = balance.SchedulePayout(valueDate, requestedBy: user.Id, requestId: cmd.RequestId);   // rules + reservation
        payouts.Add(payout);
        await uow.SaveChangesAsync(ct);                                                     // PayoutScheduled -> outbox (bank submission handler)
        return Result.Ok(new PayoutScheduledResult(payout.Id.Value, payout.Amount.Amount, payout.Amount.Currency, valueDate));
    }
}
// Bank submission: outbox-driven handler with idempotency key = payout id, intent/act/outcome, recovery for unknown outcomes.
~~~`,
  pts: [r`Framework types in Application: DbContext, HttpContext, IResult, raw HttpClient.`, r`Rules in the handler over a huge aggregate; local-time cut-off.`, r`Non-idempotent bank call with ambiguous outcomes.`, r`No concurrency control; entity and HTTP results returned.`, r`Lossy in-process notification; identity tied to HTTP.`],
  ex: r`A near-identical handler paid one merchant twice when two back-office users clicked "pay out" within a second, and marked a payout Failed after a bank timeout although the bank had executed it. The corrected design with a versioned balance aggregate and idempotent outbox submission removed both failure modes.`,
  fu: [r`Which finding would you fix first in production?`, r`How do you handle a bank timeout with unknown outcome?`, r`What tests would prevent regressions?`],
  pit: [r`Fixing only the namespaces.`, r`Ignoring the double-payout race.`, r`Treating a timeout as failure.`] },

{ id: 'q42', level: 'Principal', tags: ['clean-architecture', 'governance', 'fitness-functions', 'scale'],
  q: r`Keep architecture healthy across 60 repositories without a central gatekeeper: fitness functions, shared rule packages, dashboards, and how you handle exceptions.`,
  a: r`### Fitness functions
Automated checks that measure an architectural characteristic:
- **Structural**: dependency direction, no framework types in cores, no cross-module internals, no direct DbContext in endpoints (rich services).
- **Operational**: p95 per use case, cold start, startup time, build time.
- **Reliability**: outbox present for services that publish events, idempotency on command endpoints, timeouts on all HTTP clients.
- **Security**: no secrets in config, dependency vulnerability scans.

### Delivery
- A versioned **rules package** consumed by every repo; rules opt in by template type.
- **Renovate/Dependabot** keeps the package current.
- Results aggregated into a **dashboard** per team (pass/fail, exceptions, trend).

### Exceptions
Recorded in the repo ({{architecture-exceptions.json}}) with rule, reason, owner and **expiry date**; expired exceptions fail the build. No silent disabling.

### Human layer
- Architecture forum for decisions that change rules; ADRs.
- Team-level architecture owners (champions) rather than a central approval board.
- Quarterly review of rule usefulness: retire rules that only generate noise.`,
  code: r`~~~json
{
  "exceptions": [
    {
      "rule": "Endpoints_do_not_use_DbContext",
      "scope": "Payouts.Api.Endpoints.LegacyReports",
      "reason": "Read-only legacy report pending migration to query port",
      "owner": "team-payouts",
      "expires": "2027-01-31",
      "ticket": "PAY-1832"
    }
  ]
}
~~~
~~~csharp
// Shared rule package honours exceptions and expiry
public static class RuleRunner
{
    public static void Check(string rule, TestResult result, ArchitectureExceptions exceptions, DateOnly today)
    {
        var failing = (result.FailingTypeNames ?? []).Where(t => !exceptions.Covers(rule, t, today)).ToList();
        var expired = exceptions.ExpiredFor(rule, today).ToList();
        Assert.True(failing.Count == 0, $"{rule} violated by: {string.Join(", ", failing)}");
        Assert.True(expired.Count == 0, $"{rule} has expired exceptions: {string.Join(", ", expired.Select(e => e.Ticket))}");
    }
}
~~~`,
  pts: [r`Fitness functions for structure, operations, reliability and security.`, r`Versioned rule packages kept current automatically.`, r`Dashboards per team instead of central approval.`, r`Exceptions with owners and expiry; expired exceptions fail builds.`, r`Retire noisy rules; champions per team.`],
  ex: r`At an insurer with 60 repositories, a shared rules package and dashboard revealed 11 services without HTTP timeouts and 4 publishing events without an outbox; both classes were fixed within a quarter, preventing the kind of incident that had caused two outages the year before.`,
  fu: [r`How do you roll out a new rule without breaking 60 builds?`, r`Which fitness functions matter most for payments services?`, r`How do you keep the rules package from becoming bureaucracy?`],
  pit: [r`Central approval boards.`, r`Exceptions without expiry.`, r`Rules nobody can explain.`] },

{ id: 'q43', level: 'Principal', tags: ['clean-architecture', 'replaceability', 'migration', 'infrastructure'],
  q: r`The business wants to move from SQL Server to PostgreSQL and from RabbitMQ to Azure Service Bus. Does Clean Architecture make this "just swap the adapter"? Plan the migration honestly.`,
  a: r`### What the architecture gives you
Use cases and domain code do not change: they depend on ports ({{IPaymentRepository}}, {{IEventPublisher}}). Tests for the core keep passing. That is real value.

### What it does not give you
- **Semantics differ**: isolation levels and locking (SQL Server READ COMMITTED vs PostgreSQL MVCC), case sensitivity and collation, {{datetime2}} vs {{timestamptz}}, sequences, JSON support, query hints in raw SQL, deadlock vs serialization failure codes.
- **Messaging semantics**: RabbitMQ exchanges/routing keys vs Service Bus topics/subscriptions, sessions for ordering, dead-letter behaviour, message size limits, duplicate detection windows, prefetch and lock renewal.
- **Data migration**: moving terabytes with minimal downtime is a project of its own.
- **Operations**: monitoring, backups, failover, cost.

### Plan
1. **Port contract tests**: one suite per port run against old and new adapters (catches semantic differences).
2. Build new adapters; run integration tests on both.
3. **Data**: replicate (CDC or dual write via outbox) to PostgreSQL; verify with reconciliation.
4. **Switch reads**, then writes, per bounded context, with rollback options.
5. **Messaging**: bridge period where the outbox publishes to both brokers; consumers migrate one by one; idempotency handles duplicates.
6. Decommission after a stability period.

### Honest message
"The architecture limits the blast radius to adapters and data migration; it does not make the migration free." Budget accordingly.`,
  code: r`~~~csharp
// One contract suite, two adapters: semantic differences surface in CI
public abstract class PaymentRepositoryContract
{
    protected abstract Task<(IPaymentRepository Repo, IUnitOfWork Uow)> CreateAsync();

    [Fact]
    public async Task Concurrent_updates_conflict()
    {
        var (r1, u1) = await CreateAsync(); var (r2, u2) = await CreateAsync();
        var id = await Seed.AuthorisedPaymentAsync(r1, u1);
        var a = await r1.GetAsync(id, default); var b = await r2.GetAsync(id, default);
        a!.Capture(Money.Gbp(10)); await u1.SaveChangesAsync(default);
        b!.Capture(Money.Gbp(10));
        await Assert.ThrowsAsync<ConcurrencyConflictException>(() => u2.SaveChangesAsync(default));   // both adapters must translate
    }

    [Fact]
    public async Task Case_insensitive_reference_lookup_matches() { /* catches collation differences */ }
}
public sealed class SqlServerPayments : PaymentRepositoryContract { /* Testcontainers SQL Server */ protected override Task<(IPaymentRepository, IUnitOfWork)> CreateAsync() => SqlServerFixture.CreateAsync(); }
public sealed class PostgresPayments  : PaymentRepositoryContract { /* Testcontainers PostgreSQL */ protected override Task<(IPaymentRepository, IUnitOfWork)> CreateAsync() => PostgresFixture.CreateAsync(); }

// Bridge period: outbox relay publishes to both brokers
public sealed class DualPublisher(RabbitPublisher rabbit, ServiceBusPublisher bus) : IEventPublisher
{
    public async Task PublishAsync(OutboxMessage m, CancellationToken ct) { await rabbit.PublishAsync(m, ct); await bus.PublishAsync(m, ct); }
}
~~~`,
  pts: [r`The core stays unchanged: real value of ports.`, r`Semantics differ: isolation, collation, types, error codes, broker features.`, r`Port contract suites against old and new adapters.`, r`Data migration with replication and reconciliation; switch per context.`, r`Bridge brokers via the outbox; idempotent consumers; honest budgeting.`],
  ex: r`A fintech's SQL Server to PostgreSQL move estimated "two sprints because of Clean Architecture"; contract tests found 31 semantic differences (collation, timestamp handling, serialization failures). The domain code did not change at all, but the migration took five months, mostly data and operations.`,
  fu: [r`How do you translate PostgreSQL serialization failures into your concurrency model?`, r`How do you migrate message ordering guarantees?`, r`How do you roll back mid-migration?`],
  pit: [r`Promising a free swap.`, r`No contract tests across adapters.`, r`Ignoring data migration and operations.`] },

{ id: 'q44', level: 'Principal', tags: ['clean-architecture', 'ddd', 'cqrs', 'end-to-end-design'],
  q: r`Design a merchant-payments service end to end combining Clean Architecture, DDD and CQRS-lite: projects, aggregates, use cases, ports, read side, messaging, testing and the request lifecycle for "capture a payment".`,
  a: r`### Structure
- **Domain**: {{Payment}} aggregate (authorise, capture, refund, void lifecycle), value objects ({{Money}}, {{GatewayReference}}), domain events.
- **Application**: use cases per operation, ports ({{IPaymentRepository}}, {{IPaymentGateway}}, {{IPaymentQueries}}, {{ICurrentUser}}), validators, pipeline decorators (tracing, validation, idempotency, transaction).
- **Infrastructure**: EF Core with outbox interceptor, provider adapters with resilience, query implementations (projections), outbox relay to Kafka/Service Bus.
- **Api**: minimal API endpoints by feature, auth policies, OpenAPI, ProblemDetails; consumers and jobs as additional primary adapters.

### Capture request lifecycle
1. Endpoint authenticates, checks the {{payments:capture}} policy, maps the DTO and Idempotency-Key into {{CapturePayment}}.
2. Pipeline: trace span → validation → idempotency lookup.
3. Use case loads Payment, checks merchant ownership, records capture intent (domain validates amount and state), commits (Tx1).
4. Calls the provider port with the idempotency key (no transaction open).
5. Records the outcome (Tx2): {{PaymentCaptured}} → outbox.
6. Relay publishes integration event; ledger and merchant-funding contexts consume.
7. Query side: list/status endpoints project from tables (or a read model fed by events).

### Testing
Domain unit + property tests; use-case tests with fakes; adapter contract tests (fake vs real provider sandbox, SQL in containers); API tests via WebApplicationFactory; architecture tests.

### Operations
Use-case spans and outcome metrics, outbox age alert, provider dependency metrics, reconciliation job between captures and provider settlement reports.`,
  dia: r`sequenceDiagram
  participant C as Client
  participant E as Endpoint
  participant U as Capture use case
  participant D as Payment aggregate
  participant G as Provider adapter
  participant DB as Database and outbox
  C->>E: POST capture with Idempotency-Key
  E->>U: CapturePayment command
  U->>D: RequestCapture amount
  U->>DB: Tx1 intent
  U->>G: Capture with idempotency key
  G-->>U: Ack reference
  U->>D: ConfirmCapture
  U->>DB: Tx2 PaymentCaptured to outbox
  E-->>C: 200 with capture result`,
  code: r`~~~csharp
public sealed class CapturePaymentHandler(IPaymentRepository payments, IPaymentGateway gateway, IPaymentAuthorization authz,
                                          ICurrentUser user, IUnitOfWork uow) : IHandler<CapturePayment, Result<CaptureResult>>
{
    public async Task<Result<CaptureResult>> Handle(CapturePayment cmd, CancellationToken ct)
    {
        var payment = await payments.GetAsync(cmd.PaymentId, ct);
        if (payment is null) return Result.NotFound<CaptureResult>("payment.not_found");
        if (!(await authz.CanCaptureAsync(user, payment, ct)).Allowed) return Result.Forbidden<CaptureResult>();

        var request = payment.RequestCapture(cmd.Amount);                      // domain validates state and amount
        if (request.IsFailure) return request.Cast<CaptureResult>();
        await uow.SaveChangesAsync(ct);                                         // Tx1: intent

        var ack = await gateway.CaptureAsync(payment.GatewayRef, cmd.Amount, idempotencyKey: request.Value.CaptureId.ToString(), ct);
        payment.ConfirmCapture(request.Value.CaptureId, ack.Reference);
        await uow.SaveChangesAsync(ct);                                         // Tx2: outcome + PaymentCaptured -> outbox
        return Result.Ok(new CaptureResult(payment.Id.Value, payment.Status.ToString(), payment.Captured.Amount));
    }
}
~~~`,
  pts: [r`Domain aggregate, application use cases and ports, infrastructure adapters, API endpoints and consumers.`, r`Pipeline for tracing, validation, idempotency; transactions per step.`, r`Intent/act/outcome around provider calls; outbox for integration events.`, r`Query side projects without aggregates.`, r`Tests per ring plus contract and architecture tests; operational alerts.`],
  ex: r`A PSP built its capture service this way; when the provider had a 40-minute partial outage, captures were recorded as intents and completed automatically by the recovery job with no duplicates, and merchants saw "capture pending" rather than errors.`,
  fu: [r`Where does reconciliation with provider reports live?`, r`How do you expose capture status to merchants in real time?`, r`What changes if captures must be synchronous for the caller?`],
  pit: [r`Provider calls inside transactions.`, r`Reads through the aggregate.`, r`Events published outside the outbox.`] },

{ id: 'q45', level: 'Principal', tags: ['clean-architecture', 'decision-framework', 'subdomains'],
  q: r`Within one product you have a pricing engine, an admin back-office, a reporting module and integrations with 10 partners. Choose an architecture style per area and justify it.`,
  a: r`### Per area
| Area | Characteristics | Style |
|---|---|---|
| **Pricing engine** | core, complex rules, frequent change, heavy testing, several entry points | **Rich Clean Architecture + DDD**: domain model, use cases, ports, property-based tests |
| **Admin back-office** | CRUD screens over reference data, few rules | **Simple vertical slices**: endpoint + EF directly, validation, audit via interceptor |
| **Reporting** | read-only, SQL is the artefact, large data | **Query-focused**: SQL views/Dapper or a reporting store fed by events; no domain model |
| **Partner integrations** | many external protocols, translation, retries | **Hexagonal adapters**: one port per capability, adapter per partner, ACL translation, contract tests per partner |

### Principles
- Architecture follows **the problem's shape**, not a company template.
- Boundaries between areas are explicit (contracts/events), so each area can use its own style.
- Complexity is concentrated where the business value is (pricing).
- Revisit when an area's shape changes (back-office starts having approval workflows → introduce a domain model there).

### How to defend it
Show the cost of uniform heavy architecture (slow CRUD delivery) and the risk of uniform light architecture (pricing rules scattered), and tie each choice to measurable outcomes.`,
  code: r`~~~text
src/
  Pricing/                      rich: Pricing.Domain, Pricing.Application, Pricing.Infrastructure, Pricing.Api
  BackOffice/                   slices: Features/Countries/UpdateCountry.cs (endpoint + EF + validator)
  Reporting/                    queries: Reports/MerchantRevenue.sql + Dapper endpoints, read replica
  Partners/
    Partners.Application/       ports: IQuoteSource, IOrderSubmission
    Partners.Adapters.Acme/     ACL + contract tests (recorded fixtures)
    Partners.Adapters.Globex/   ACL + contract tests
~~~
~~~csharp
// Partner capability port; each partner is one adapter with its own translation
public interface IQuoteSource { string PartnerCode { get; } Task<PartnerQuote> GetQuoteAsync(QuoteRequest r, CancellationToken ct); }
public sealed class QuoteAggregator(IEnumerable<IQuoteSource> sources)
{
    public async Task<IReadOnlyList<PartnerQuote>> BestQuotesAsync(QuoteRequest r, CancellationToken ct)
    {
        var tasks = sources.Select(s => s.GetQuoteAsync(r, ct).WaitAsync(TimeSpan.FromMilliseconds(800), ct));
        var results = await Task.WhenAll(tasks.Select(t => t.ContinueWith(x => x.IsCompletedSuccessfully ? x.Result : null, TaskScheduler.Default)));
        return results.OfType<PartnerQuote>().OrderBy(q => q.Price).ToList();
    }
}
~~~`,
  pts: [r`Choose style per area by complexity, change rate and data shape.`, r`Rich Clean + DDD for the core pricing engine.`, r`Vertical slices for CRUD back-office.`, r`Query-focused design for reporting.`, r`Hexagonal adapters per partner with contract tests.`],
  ex: r`A travel platform applied its rich template to back-office screens and its CRUD-style approach to pricing; pricing bugs were frequent and admin features slow. Reversing the styles per area improved both within two quarters.`,
  fu: [r`How do you keep the areas' boundaries explicit in one repo?`, r`When does the back-office deserve a domain model?`, r`How do you onboard developers to several styles?`],
  pit: [r`One style for everything.`, r`Domain models for reporting.`, r`Partner specifics leaking into the core.`] },

{ id: 'q46', level: 'Principal', tags: ['clean-architecture', 'microservices', 'modular-monolith', 'decomposition'],
  q: r`Should a Clean Architecture modular monolith be split into microservices? Give the criteria, the order of extraction, and what Clean boundaries make easier or do not help with.`,
  a: r`### Reasons to split (need at least one strong one)
- **Independent scaling** with materially different load profiles (pricing at 10,000 req/s vs admin at 10 req/min).
- **Independent deployment cadence** blocked by the shared release (teams waiting on each other).
- **Fault isolation**: a module's failures (memory, CPU) take down unrelated critical flows.
- **Different technology or compliance needs** (PCI scope reduction, data residency).
- **Team scaling**: many teams contending on one deployable.

### Reasons not to
Fashion, "microservices are modern", small team, unclear boundaries, no platform for observability, deployment and messaging.

### What Clean boundaries make easier
Modules already talk through contracts and events, own their schemas, and have use cases independent of delivery: extraction becomes moving projects, swapping in-process calls for HTTP/messaging adapters, and moving data.

### What they do not solve
Network failures and latency, distributed transactions (now sagas), eventual consistency in places that were atomic, versioning of contracts between deployables, operational overhead (more pipelines, dashboards, on-call).

### Order
Extract the module with the strongest reason and the cleanest boundary first (measured by change coupling and cross-module calls), one at a time, keeping the rest together.`,
  code: r`~~~csharp
// Before extraction: in-process adapter for the module contract
internal sealed class InProcessPricingClient(IHandler<GetPrice, Result<PriceDto>> handler) : IPricingModule
{
    public async Task<PriceDto?> GetPriceAsync(Sku sku, CancellationToken ct) => (await handler.Handle(new GetPrice(sku), ct)).ValueOrDefault();
}

// After extraction: same contract, HTTP adapter with resilience; callers unchanged
internal sealed class HttpPricingClient(HttpClient http) : IPricingModule
{
    public async Task<PriceDto?> GetPriceAsync(Sku sku, CancellationToken ct) =>
        await http.GetFromJsonAsync<PriceDto>($"/v1/prices/{Uri.EscapeDataString(sku.Value)}", ct);
}

// Composition root decides
if (cfg.GetValue<bool>("Pricing:Remote"))
    builder.Services.AddHttpClient<IPricingModule, HttpPricingClient>(c => c.BaseAddress = new Uri(cfg["Pricing:Url"]!)).AddStandardResilienceHandler();
else
    builder.Services.AddScoped<IPricingModule, InProcessPricingClient>();
~~~`,
  pts: [r`Split for scaling, deployment cadence, fault isolation, compliance or team scaling.`, r`Do not split for fashion or with unclear boundaries.`, r`Clean module contracts make extraction mechanical.`, r`They do not remove distributed-systems costs.`, r`Extract one module at a time, strongest reason and cleanest boundary first.`],
  ex: r`An e-commerce modular monolith extracted only pricing (100x the load of other modules) as a service; the other eight modules stayed together. Extraction took four weeks thanks to existing contracts, and infrastructure cost dropped because only pricing needed to scale out.`,
  fu: [r`How do you handle a transaction that spanned two modules after extraction?`, r`What platform capabilities must exist before splitting?`, r`How do you measure change coupling between modules?`],
  pit: [r`Splitting everything at once.`, r`Splitting without observability and deployment automation.`, r`Assuming contracts remove eventual-consistency work.`] },

{ id: 'q47', level: 'Principal', tags: ['clean-architecture', 'regulated', 'longevity', 'audit'],
  q: r`You are designing a core banking component expected to live 15+ years under regulatory scrutiny. How does that horizon change your architecture decisions beyond "use Clean Architecture"?`,
  a: r`### Assume everything outside the core will change
Frameworks (.NET versions every year, LTS every two), databases, message brokers, cloud providers, identity systems, regulations, and the people. Design so the **business rules and their history** survive those changes.

### Decisions
1. **Domain core with minimal dependencies**: no frameworks; value objects and rules in plain C#; this code should compile in 10 years with minor changes.
2. **Ports for everything external**, contract tests for each, so infrastructure migrations are bounded projects.
3. **Data outlives code**: well-documented schemas, append-only financial records, explicit versioning of stored formats and events, export capability in open formats.
4. **Auditability by design**: every use case records who/what/when/why; decisions stored with inputs and rule versions; immutable ledgers; temporal history.
5. **Explicit rule versioning and effective dating**: rules in force on a past date can be re-executed for disputes.
6. **Documentation as code**: ADRs, C4 diagrams, glossary, runbooks in the repo.
7. **Upgrade cadence as policy**: framework upgrades scheduled (LTS to LTS), dependency hygiene automated, so the system never falls a decade behind.
8. **Knowledge continuity**: tests as executable specification; domain experts' rules captured in readable tests.

### What to avoid
Proprietary features that lock rules inside a vendor (rules engines, stored procedures, workflow designers) without exportable definitions.`,
  code: r`~~~csharp
// Rules versioned and effective-dated so past decisions can be reproduced
public interface IInterestRule { string Version { get; } DateOnly EffectiveFrom { get; } Money Calculate(Money balance, Period p); }
public sealed class InterestRules(IEnumerable<IInterestRule> all)
{
    public IInterestRule InForceOn(DateOnly day) => all.Where(r => r.EffectiveFrom <= day).MaxBy(r => r.EffectiveFrom)!;
}

// Every use case writes an audit record in the same transaction
public sealed record AuditRecord(Guid Id, string UseCase, string Actor, string Reason, string RuleVersion,
                                 string InputsHash, DateTimeOffset At, string CorrelationId);

// Executable specification readable by domain experts (survives staff turnover)
[Fact]
public void Interest_for_March_2027_uses_rule_v7_for_balances_over_tier_2() =>
    Assert.Equal(Money.Gbp(41.10m), InterestRules.Production.InForceOn(new(2027, 3, 1)).Calculate(Money.Gbp(12_000m), Period.Month(2027, 3)));
~~~`,
  pts: [r`Assume frameworks, databases, clouds and people will change.`, r`Minimal-dependency domain core; ports with contract tests.`, r`Data outlives code: append-only, versioned formats, exportable.`, r`Audit, decision records and rule versioning by design.`, r`Scheduled upgrade cadence; documentation and tests as knowledge continuity.`],
  ex: r`A building society's 20-year-old core had its interest rules inside a vendor's proprietary scripting language; when the vendor ended support, reconstructing the rules took 18 months. Its replacement kept rules in a framework-free C# domain with versioned, effective-dated rule sets and expert-readable tests.`,
  fu: [r`How do you keep a domain core compiling across 8 .NET versions?`, r`How do you re-run a decision from 7 years ago?`, r`What do you document, and where?`],
  pit: [r`Rules locked in proprietary tools.`, r`Upgrades postponed for years.`, r`History overwritten in place.`] },

{ id: 'q48', level: 'Principal', tags: ['clean-architecture', 'documentation', 'onboarding', 'c4'],
  q: r`New engineers take six weeks to become productive in your Clean Architecture codebase. How do you reduce cognitive load through documentation, conventions and tooling, without dumbing down the architecture?`,
  a: r`### Diagnose
Ask recent joiners where they got lost: "where does this request go?", too many projects, mediator indirection, unclear naming, tribal rules not written anywhere, slow local setup.

### Make the architecture visible
- **C4 diagrams** (context, container, component) as code (Structurizr/Mermaid) in the repo, updated in PRs that change structure.
- **ADRs** explaining *why* (why outbox, why no generic repository).
- A one-page **"how a request flows"** guide with a real use case traced through the rings.
- **Glossary** of the domain language.

### Make the code navigable
- Feature folders: everything for {{IssueRefund}} findable by name.
- Explicit handlers rather than heavy mediator indirection; consistent naming ({{XxxHandler}}, {{XxxEndpoint}}).
- Fewer projects where possible.
- Architecture tests that explain rules in their failure messages.

### Make the first weeks productive
- One-command local setup (containers for dependencies).
- "Starter" tasks that touch every ring once, with a buddy.
- Templates and code generators for new use cases.

### Measure
Time to first PR, time to first independent feature, onboarding survey; revisit after each cohort.`,
  code: r`~~~text
docs/
  architecture/
    c4-context.md        (Mermaid, rendered in the portal)
    c4-containers.md
    request-flow.md      "IssueRefund from HTTP to ledger, step by step"
    adr/
      0001-clean-architecture-for-core-services.md
      0007-outbox-for-integration-events.md
      0012-no-generic-repositories.md
  glossary.md            capture, authorisation, chargeback, reserve, payout...
tools/
  new-usecase.ps1        scaffolds command, handler, validator, endpoint, tests in a feature folder
~~~
~~~csharp
// Architecture test messages that teach
Assert.True(result.IsSuccessful,
    "Application must not reference EF Core. Put queries behind a port in Application and implement them in Infrastructure. " +
    "See docs/architecture/adr/0012-no-generic-repositories.md");
~~~`,
  pts: [r`Ask joiners where they got lost.`, r`C4 diagrams, ADRs, request-flow guide and glossary in the repo.`, r`Feature folders, explicit handlers, consistent naming, fewer projects.`, r`One-command setup, starter tasks, scaffolding tools.`, r`Measure time to first PR and first feature.`],
  ex: r`A payments team cut onboarding from six weeks to two by adding a request-flow guide, a use-case scaffolder and feature folders, and by replacing 11 mediator behaviours with 4 explicit decorators; the architecture's boundaries stayed the same.`,
  fu: [r`How do you keep diagrams up to date?`, r`What belongs in an ADR?`, r`How do you onboard someone to the domain, not just the code?`],
  pit: [r`Undocumented conventions.`, r`Diagrams that drift.`, r`Indirection without navigation aids.`] },

{ id: 'q49', level: 'Principal', tags: ['clean-architecture', 'build-times', 'testing-economics', 'developer-experience'],
  q: r`CI takes 35 minutes for a Clean Architecture solution with 40 projects and 6,000 tests. Analyse the economics (project count, test pyramid, integration tests) and propose changes.`,
  a: r`### Where time goes
- **Project count**: each project adds restore/build overhead and serialises parts of the build graph; 40 projects for a handful of services is often 3x more than needed.
- **Tests**: integration tests starting containers per test class; end-to-end tests doing what use-case tests could do; duplicated tests at several levels.
- **No incremental builds or caching** in CI; all tests run for every change.

### Changes
1. **Consolidate projects** that provide no boundary (Contracts + Abstractions + Shared merged; test projects per ring instead of per class).
2. **Shared container fixtures** per test run (Testcontainers with Respawn), parallel test collections.
3. **Rebalance the pyramid**: move business-rule coverage to domain/use-case tests (milliseconds), keep integration tests for adapters (mapping, queries, concurrency), keep few API tests per critical flow.
4. **Test impact analysis / affected projects** to run only relevant tests on PRs, full suite nightly or pre-merge.
5. **CI caching**: NuGet cache, build output caching, container image caching; split pipeline stages in parallel.
6. Track **flaky tests** and quarantine with owners.

### Economics
CI time multiplies by every PR and every engineer: 35 minutes × 80 PRs/day is ~47 engineer-hours of waiting daily (context switches included, more). Faster feedback directly improves throughput and quality; it is an architecture concern.`,
  code: r`~~~csharp
// One container for the whole test run, reset between tests
[CollectionDefinition("sql")] public sealed class SqlCollection : ICollectionFixture<SqlFixture>;

public sealed class SqlFixture : IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder().WithReuse(true).Build();
    private Respawner _respawner = null!;
    public string Cs => _sql.GetConnectionString();
    public async Task InitializeAsync()
    {
        await _sql.StartAsync();
        await using var db = new PaymentsDbContext(new DbContextOptionsBuilder<PaymentsDbContext>().UseSqlServer(Cs).Options);
        await db.Database.MigrateAsync();
        _respawner = await Respawner.CreateAsync(Cs);
    }
    public Task ResetAsync() => _respawner.ResetAsync(Cs);
    public Task DisposeAsync() => _sql.DisposeAsync().AsTask();
}
~~~
~~~yaml
# CI: affected projects only on PRs, full suite on main
- run: dotnet tool run dotnet-affected --from origin/main --format traversal --output affected.proj
- run: dotnet test affected.proj --no-restore --parallel --blame-hang-timeout 5m
- run: dotnet test Solution.sln --no-restore
  if: github.ref == 'refs/heads/main'
~~~`,
  pts: [r`Project count and container-per-class integration tests dominate CI time.`, r`Consolidate boundary-less projects.`, r`Shared container fixtures with Respawn; parallel collections.`, r`Rules tested in fast inner tests; integration tests for adapters only.`, r`Affected-test selection, caching, flaky-test ownership; CI time is an architecture concern.`],
  ex: r`A team reduced CI from 35 to 9 minutes by merging 40 projects into 14, sharing one SQL container per run, and moving 1,800 rule tests from API level to use-case level; PR throughput rose by 30% the following quarter.`,
  fu: [r`How do you decide which projects to merge?`, r`How do you prevent coverage loss when moving tests inward?`, r`What is a reasonable CI time budget?`],
  pit: [r`Treating CI time as someone else's problem.`, r`Testing business rules through HTTP.`, r`Projects that enforce nothing.`] },

{ id: 'q50', level: 'Principal', tags: ['clean-architecture', 'native-aot', 'source-generators', 'platform-constraints'],
  q: r`The platform wants Native AOT for faster startup and lower memory in containers and functions. What does that mean for a Clean Architecture codebase (DI, mediators, mapping, EF Core, serialization), and how do you decide?`,
  a: r`### AOT constraints
Native AOT compiles ahead of time with **trimming**: no runtime code generation, limited reflection, everything reachable must be known at compile time.

### Impact by concern
| Concern | AOT-friendly choice |
|---|---|
| DI | built-in container works; avoid assembly scanning by reflection (Scrutor) or use source-generated registration |
| Mediator | source-generated mediators or plain handlers; reflection-based dispatch problematic |
| Mapping | manual or Mapperly (source-generated); AutoMapper not AOT-friendly |
| JSON | System.Text.Json **source generation** ({{JsonSerializerContext}}) for all DTOs |
| Minimal APIs | supported with the request delegate generator; controllers are not supported for AOT |
| EF Core | precompiled queries/compiled models: support is evolving; verify for your version; Dapper with source-generated mapping (Dapper.AOT) as an alternative |
| Validation | FluentValidation works; DataAnnotations rely on reflection |
| Logging | source-generated {{LoggerMessage}} |

### Architecture fit
Clean Architecture itself is neutral; the **libraries** commonly used with it (reflection-heavy mediators and mappers) are the problem. Ports and adapters help: replace adapters (EF → Dapper.AOT for a function) without touching the core.

### Decision
AOT pays off for **scale-to-zero functions, CLI tools, sidecars, high-density containers**. For long-running APIs, ReadyToRun + tiered PGO often gives most of the startup benefit with fewer constraints. Pilot one service, measure startup, memory, throughput and developer friction.`,
  code: r`~~~xml
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <InvariantGlobalization>true</InvariantGlobalization>
  <IsAotCompatible>true</IsAotCompatible>   <!-- surfaces trimming/AOT warnings in libraries -->
</PropertyGroup>
~~~
~~~csharp
// Source-generated JSON for every contract
[JsonSerializable(typeof(CapturePaymentRequest))]
[JsonSerializable(typeof(CaptureResponse))]
[JsonSerializable(typeof(ProblemDetails))]
internal partial class ApiJsonContext : JsonSerializerContext;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Insert(0, ApiJsonContext.Default));

// Explicit DI registration instead of reflection scanning
builder.Services.AddScoped<IHandler<CapturePayment, Result<CaptureResult>>, CapturePaymentHandler>();

// Source-generated logging
internal static partial class Log
{
    [LoggerMessage(Level = LogLevel.Information, Message = "Captured {PaymentId} for {Amount}")]
    public static partial void Captured(ILogger logger, Guid paymentId, decimal amount);
}
~~~`,
  pts: [r`AOT forbids runtime codegen and limits reflection.`, r`Choose source-generated DI, mediators, mapping, JSON and logging.`, r`Minimal APIs over controllers; verify EF Core AOT support for your version.`, r`Ports let you swap AOT-hostile adapters without touching the core.`, r`Use AOT where startup and density matter; otherwise ReadyToRun and PGO.`],
  ex: r`A team moved a payment-notification function to Native AOT: cold start fell from 2.1 s to 180 ms and memory from 160 MB to 45 MB. They replaced AutoMapper with Mapperly and MediatR with plain handlers; the domain and application code did not change.`,
  fu: [r`How do you find AOT-incompatible dependencies early?`, r`What about EF Core in AOT services today?`, r`Is AOT worth it for a long-running API?`],
  pit: [r`Adopting AOT without a measured need.`, r`Ignoring trimming warnings.`, r`Reflection-based libraries in AOT targets.`] }
],
cheat: r`### Core idea
Business rules at the centre; frameworks, UI, databases and vendors are plug-ins. Dependency Rule: source dependencies point inward only; control flows outward through ports (interfaces owned by the inner ring) implemented by adapters (outer ring); the composition root (host) wires them.

### Rings and projects
| Ring | Project | References | Contains |
|---|---|---|---|
| Entities | Domain | nothing | aggregates, value objects, domain events, domain services |
| Use cases | Application | Domain | handlers per operation, ports, validators, DTOs |
| Adapters | Infrastructure / Api | inward | EF Core, gateways, outbox, endpoints, consumers |
| Frameworks | host | all | Program.cs composition root |

### What crosses boundaries
Commands, results, response models, inner-owned interfaces. Never HttpContext, DbContext, IQueryable, vendor SDK types, entities as API contracts. Map at edges; no pass-through mapping layers.

### Use case checklist
Load via ports → authorize against the resource → call domain (rules live there) → external calls outside transactions (intent/act/outcome, idempotency key) → SaveChanges (events → outbox) → return Result. No HTTP concepts, no business rules in handlers.

### Pipeline (outer → inner)
Tracing → exception mapping → authorization (coarse) → validation → idempotency → transaction (commands only) → handler. Mechanical only.

### Enforcement
One-way project references + architecture tests (NetArchTest): Domain framework-free, Application without EF/Infrastructure, endpoints without Infrastructure, adapters internal, no public setters, exceptions with owner + expiry.

### Testing per ring
Domain: unit + property tests. Application: fakes for ports. Infrastructure: Testcontainers, WireMock, port contract suites (fake and real must pass the same tests). Api: WebApplicationFactory. Architecture tests.

### Pragmatism
Mediator optional (MediatR licensed since 2025; source-generated or plain handlers). EF entities = domain entities via fluent config in most cases. Reads bypass aggregates (query ports/projections). Batch-shaped ports avoid N+1. Vertical slices inside Application; simple template for CRUD services; collapse projects that enforce nothing.

### Cross-cutting ports
ICurrentUser, ITenantContext, TimeProvider, options records, Activity/Meter. Adapters per entry point (HTTP, consumer, job). Caching as decorators on ports or at the edge; never in the domain or write decisions. Flags choose adapters/policies, not branches in the domain. Config chosen in the composition root with startup guards; secrets from vaults.

### Principal moves
Characterisation tests → extract domain → ports over legacy → parallel run → strangle → replace infra. Two or three templates + ServiceDefaults + shared rule package. Choose style per area (rich core, slices for CRUD, query-first reporting, hexagonal partner adapters). Contract tests make infrastructure swaps honest, not free. Split modules into services only for scaling, cadence, isolation, compliance. AOT: source-generated everything. CI time and onboarding are architecture metrics.`
});
})(String.raw);
