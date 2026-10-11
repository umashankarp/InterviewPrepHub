(function (r) {
registerTopic('33-hexagonal-architecture', {
related: ['32-clean-architecture', '30-architecture-patterns', '31-domain-driven-design'],
questions: [
{ id: 'q1', level: 'Basic', tags: ['hexagonal', 'ports-and-adapters', 'fundamentals'],
  q: r`Explain hexagonal architecture (ports and adapters) in a minute: Cockburn's original goal, why a hexagon, and what "the application can be driven equally by users, programs, tests or batch scripts" means in practice.`,
  a: r`Alistair Cockburn (2005): "Allow an application to equally be driven by users, programs, automated tests or batch scripts, and to be developed and tested in isolation from its eventual run-time devices and databases."

### The model
- The **application core** (business logic) sits inside the hexagon.
- It interacts with the outside **only through ports**: technology-agnostic contracts describing what it **offers** (use cases) and what it **needs** (storage, notifications, external services).
- **Adapters** translate between a port and one concrete technology (HTTP, FIX, SQL, Kafka, a test).

### Why a hexagon
The shape has no meaning beyond "many sides, no top or bottom". Unlike layered diagrams (UI on top, database at the bottom), the UI and the database are **both just outside**: symmetry is the point.

### What "driven equally" means
The same core runs unchanged when invoked by:
- a REST or gRPC endpoint,
- a message consumer or scheduler,
- a CLI or batch file,
- an **automated test** calling the inbound port directly (no UI, no web server),
and with driven sides swapped between a real database, an in-memory store, a simulator or a sandbox.

### Benefits
Fast, deterministic tests of business behaviour; technology changes isolated in adapters; several delivery channels sharing one behaviour; reproducible environments (simulators, replays).`,
  dia: r`flowchart LR
  REST[REST adapter] --> IN((Inbound port: IPlaceOrder))
  FIX[FIX acceptor adapter] --> IN
  TEST[Test harness] --> IN
  IN --> CORE[Application core]
  CORE --> OUT1((Outbound port: IOrderStore))
  CORE --> OUT2((Outbound port: IExchangeGateway))
  SQL[SQL adapter] -.->|implements| OUT1
  MEM[In-memory adapter] -.->|implements| OUT1
  EXCH[Exchange FIX adapter] -.->|implements| OUT2
  SIM[Exchange simulator adapter] -.->|implements| OUT2`,
  code: r`~~~csharp
// Inbound port: what the core offers
public interface IPlaceOrder { Task<PlaceOrderResult> ExecuteAsync(PlaceOrderCommand cmd, CancellationToken ct); }

// Outbound ports: what the core needs, in its own terms
public interface IOrderStore { Task SaveAsync(Order order, CancellationToken ct); }
public interface IExchangeGateway { Task<ExchangeAck> SendAsync(Order order, CancellationToken ct); }

// The same core driven by a test, with no web server, database or exchange
[Fact]
public async Task Order_over_risk_limit_is_rejected()
{
    var core = new PlaceOrderService(new InMemoryOrderStore(), new InMemoryExchange(), new FixedRiskLimits(1_000m), new FakeTimeProvider());
    var result = await core.ExecuteAsync(Commands.Buy("VOD.L", qty: 1_000, price: 2.50m), default);
    Assert.Equal("risk.limit", result.Reason);
}
~~~`,
  pts: [r`Core inside, ports at the edge, adapters outside.`, r`Ports are technology-agnostic contracts; adapters bind one technology.`, r`UI and database are both outside: no top or bottom.`, r`The same core runs from HTTP, messages, CLI or tests.`, r`Driven sides swap between real, in-memory, simulator and sandbox.`],
  ex: r`A broker's order router could only be tested against a shared exchange test environment that was available two hours a day. Restructuring around ports let the team run 4,000 order-handling scenarios against an in-memory exchange in under a minute on every commit.`,
  fu: [r`How is hexagonal different from a classic layered architecture?`, r`Is a port always an interface?`, r`What does "driven by a test" look like for an event-driven system?`],
  pit: [r`Treating the hexagon shape as meaningful.`, r`Ports defined by the infrastructure.`, r`Adapters containing business logic.`] },

{ id: 'q2', level: 'Basic', tags: ['hexagonal', 'driving', 'driven', 'dependency-direction'],
  q: r`Primary (driving) vs secondary (driven) ports and adapters: who initiates, who owns the port, which way do dependencies point on each side, and give three examples of each.`,
  a: r`| | Primary / driving side | Secondary / driven side |
|---|---|---|
| Initiator | the outside world calls the application | the application calls the outside world |
| Port | **inbound port**: a use-case interface ({{IPlaceOrder}}, {{ICapturePayment}}) | **outbound port**: a dependency interface ({{IOrderStore}}, {{IExchangeGateway}}, {{INotifier}}) |
| Adapter | REST/gRPC endpoint, message consumer, CLI, scheduler, test harness, UI | EF Core repository, HTTP client to a vendor, Kafka producer, SMTP sender, fake |
| Adapter's relation to port | **calls** it | **implements** it |
| Ownership of port | core | core |

### Dependency direction
On **both** sides the adapter depends on the core: driving adapters reference the inbound port to call it; driven adapters reference the outbound port to implement it. The core references neither. That is the inversion.

### Examples
- Driving: an HTTP endpoint for placing orders; a Kafka consumer of {{TradeBooked}} events; a nightly scheduler running interest accrual; an acceptance test.
- Driven: a SQL order store; a FIX gateway to an exchange; an email/SMS notifier; a market-data feed client; a clock.

### Note on events
A message broker can be on both sides: consuming is driving, publishing is driven. Two different adapters, two different ports.`,
  code: r`~~~csharp
// Driving adapter: calls the inbound port
app.MapPost("/orders", async (PlaceOrderRequest r, IPlaceOrder placeOrder, CancellationToken ct) =>
    (await placeOrder.ExecuteAsync(r.ToCommand(), ct)) switch
    {
        { Accepted: true } res => Results.Accepted($"/orders/{res.OrderId}"),
        var res => Results.UnprocessableEntity(new { res.Reason })
    });

// Another driving adapter: Kafka consumer calls the same inbound port
public sealed class OrderRequestConsumer(IServiceScopeFactory scopes) : IConsumer<OrderRequestedV1>
{
    public async Task Consume(OrderRequestedV1 m, CancellationToken ct)
    {
        await using var s = scopes.CreateAsyncScope();
        await s.ServiceProvider.GetRequiredService<IPlaceOrder>().ExecuteAsync(m.ToCommand(), ct);
    }
}

// Driven adapters: implement outbound ports
internal sealed class SqlOrderStore(TradingDbContext db) : IOrderStore
{
    public async Task SaveAsync(Order o, CancellationToken ct) { db.Update(o); await db.SaveChangesAsync(ct); }
}
internal sealed class KafkaOrderEvents(IProducer<string, byte[]> producer) : IOrderEvents
{
    public Task PublishAsync(OrderAccepted e, CancellationToken ct) =>
        producer.ProduceAsync("orders.accepted", new() { Key = e.OrderId.ToString(), Value = Serializer.ToBytes(e) }, ct);
}
~~~`,
  pts: [r`Driving side: outside calls the app through inbound ports.`, r`Driven side: app calls outside through outbound ports.`, r`Both kinds of adapters depend on the core.`, r`The core owns every port.`, r`A broker can appear on both sides as different adapters.`],
  ex: r`A team's Kafka consumer contained the order-validation logic while the REST endpoint called a service; rules diverged and some orders rejected via API were accepted via Kafka. Making both driving adapters call the same inbound port removed the divergence.`,
  fu: [r`Is a scheduler a driving or a driven adapter?`, r`Where does the clock sit?`, r`Can one adapter be both driving and driven?`],
  pit: [r`Logic inside driving adapters.`, r`Driven adapters defining the port shape.`, r`Confusing consumer and producer roles.`] },

{ id: 'q3', level: 'Basic', tags: ['hexagonal', 'csharp', 'project-structure'],
  q: r`Implement ports and adapters in a .NET solution: where inbound and outbound ports live, whether an inbound port needs an interface, how adapters are registered, and how to keep the core free of infrastructure.`,
  a: r`### Structure
| Project | Contains | References |
|---|---|---|
| {{Trading.Core}} | domain model, inbound ports (use cases), outbound port interfaces, core services | nothing infrastructural |
| {{Trading.Adapters.Http}} | endpoints (driving) | Core |
| {{Trading.Adapters.Fix}} | FIX acceptor (driving) and FIX exchange gateway (driven) | Core, QuickFIX/n |
| {{Trading.Adapters.Persistence}} | SQL store (driven) | Core, EF Core |
| {{Trading.Host}} | composition root per environment | all |

Splitting adapters per technology keeps heavy dependencies (FIX engines, vendor SDKs) out of other adapters and lets hosts include only what they need.

### Inbound ports: interface or class?
Conceptually a port is a **contract**. In C#:
- An **interface** ({{IPlaceOrder}}) helps when there are decorators, several implementations, or when driving adapters should not see implementation details.
- A **concrete service class** is fine when there is one implementation; the essential part is that the **core defines it** and adapters call it.

### Outbound ports
Always interfaces (or delegates) owned by the core, implemented by adapters.

### Registration
Core exposes {{AddTradingCore()}}; each adapter project exposes {{AddFixExchange(config)}}, {{AddSqlPersistence(config)}}; the host chooses which to call.`,
  code: r`~~~csharp
// Trading.Core: inbound and outbound ports + core service
namespace Trading.Core.Ports.Inbound  { public interface IPlaceOrder { Task<PlaceOrderResult> ExecuteAsync(PlaceOrderCommand c, CancellationToken ct); } }
namespace Trading.Core.Ports.Outbound
{
    public interface IOrderStore { Task SaveAsync(Order o, CancellationToken ct); }
    public interface IExchangeGateway { Task<ExchangeAck> SendAsync(Order o, CancellationToken ct); }
    public interface IRiskLimits { Task<bool> HasCapacityAsync(AccountId a, Money notional, CancellationToken ct); }
}
namespace Trading.Core
{
    internal sealed class PlaceOrderService(IOrderStore store, IExchangeGateway exchange, IRiskLimits risk, TimeProvider clock) : IPlaceOrder
    {
        public async Task<PlaceOrderResult> ExecuteAsync(PlaceOrderCommand cmd, CancellationToken ct)
        {
            var order = Order.Create(cmd.Account, cmd.Instrument, cmd.Side, cmd.Quantity, cmd.LimitPrice, clock.GetUtcNow());
            if (!await risk.HasCapacityAsync(cmd.Account, order.Notional, ct)) return PlaceOrderResult.Rejected("risk.limit");
            await store.SaveAsync(order, ct);
            var ack = await exchange.SendAsync(order, ct);
            order.MarkSent(ack.ExchangeOrderId);
            await store.SaveAsync(order, ct);
            return PlaceOrderResult.Accepted(order.Id);
        }
    }
    public static class CoreRegistration { public static IServiceCollection AddTradingCore(this IServiceCollection s) => s.AddScoped<IPlaceOrder, PlaceOrderService>(); }
}

// Host: chooses adapters
builder.Services.AddTradingCore();
builder.Services.AddSqlPersistence(builder.Configuration);
builder.Services.AddFixExchange(builder.Configuration);
~~~`,
  pts: [r`Core project owns domain, inbound and outbound ports.`, r`Adapter projects per technology keep heavy dependencies isolated.`, r`Inbound ports may be interfaces or core classes; the core defines them.`, r`Outbound ports are core-owned interfaces.`, r`Hosts compose cores and adapters per deployment.`],
  ex: r`A trading firm split adapters per technology; a lightweight risk-checking worker could reuse the core without pulling the QuickFIX/n engine and its native dependencies, cutting the worker's image from 900 MB to 140 MB.`,
  fu: [r`When does an inbound port interface add value?`, r`How many adapter projects is too many?`, r`Where do DTOs for HTTP live?`],
  pit: [r`Ports defined in adapter projects.`, r`One giant Infrastructure project with every SDK.`, r`Core referencing EF Core for convenience.`] },

{ id: 'q4', level: 'Basic', tags: ['hexagonal', 'port-design', 'leaky-abstractions'],
  q: r`What makes a good port? Contrast domain-shaped ports (IExchangeGateway, IOrderStore) with technology-shaped ones (IDbConnectionFactory, IHttpSender, IKafkaProducer), and explain why the latter defeat the purpose.`,
  a: r`### A good port
- Named and shaped in the **core's language**: what the application needs, not how it is done ({{SendAsync(Order)}}, {{HasCapacityAsync(account, notional)}}).
- **Technology-neutral** types: domain objects or simple DTOs, not {{DbCommand}}, {{HttpResponseMessage}}, {{ConsumeResult}}.
- **Semantics specified**: idempotency, ordering, consistency, error outcomes, timeouts.
- **Implementable by several adapters** (real, simulator, fake) without contortion.
- **Granularity** matching the use cases: not one method per SQL statement, not one god interface.

### Technology-shaped ports
{{IDbConnectionFactory}}, {{ISqlExecutor}}, {{IHttpSender}}, {{IKafkaProducer}} only wrap a library. The core still thinks in SQL, HTTP or Kafka: swapping technology changes the core, tests must simulate the technology (fake SQL!), and business meaning is hidden in strings.

### Tests for a port's quality
1. Could you implement it with a completely different technology (file, in-memory, another vendor)?
2. Would a domain expert understand the method names?
3. Can a fake implement it in a few lines?
4. Does it mention any library type?`,
  code: r`~~~csharp
// Technology-shaped: the core still writes SQL and knows HTTP
public interface ISqlExecutor { Task<int> ExecuteAsync(string sql, object parameters); }
public interface IHttpSender { Task<HttpResponseMessage> PostAsync(string url, object body); }

public async Task PlaceOrderBad(PlaceOrderCommand c)
{
    await sql.ExecuteAsync("INSERT INTO Orders (...) VALUES (...)", c);                    // persistence detail in the core
    var resp = await http.PostAsync("https://exchange/api/orders", c.ToExchangeJson());      // protocol detail in the core
    if (resp.StatusCode == HttpStatusCode.Conflict) { /* exchange-specific semantics */ }
}

// Domain-shaped: meaning in the core, technology in adapters
public interface IOrderStore
{
    Task SaveAsync(Order order, CancellationToken ct);
    Task<Order?> GetAsync(OrderId id, CancellationToken ct);
}
public interface IExchangeGateway
{
    /// Sends a new order. Idempotent per order id; throws ExchangeRejectedException with a reason code on business reject;
    /// throws ExchangeUnavailableException on connectivity failure (outcome unknown, reconcile by order id).
    Task<ExchangeAck> SendAsync(Order order, CancellationToken ct);
}
~~~`,
  pts: [r`Ports speak the core's language and use domain or neutral types.`, r`Semantics (idempotency, errors, ordering) are part of the contract.`, r`Technology-shaped ports leave technology in the core.`, r`A good port is implementable by a fake in a few lines.`, r`Granularity follows use cases.`],
  ex: r`A payments core used an IHttpSender port; moving one provider from REST to ISO 8583 over TCP required rewriting core code. Re-shaping the port as IAuthorisationGateway made the next protocol change an adapter-only project.`,
  fu: [r`How do you document the semantics of a port?`, r`Should a port expose IQueryable?`, r`How fine-grained should a persistence port be?`],
  pit: [r`Library wrappers called ports.`, r`Library types in port signatures.`, r`Undocumented failure semantics.`] },

{ id: 'q5', level: 'Basic', tags: ['hexagonal', 'port-selection', 'time', 'randomness'],
  q: r`Which dependencies should become ports and which should stay concrete? Include the clock, randomness, id generation, configuration and in-process domain collaborators.`,
  a: r`### Make it a port when it is
- **Infrastructure or external**: persistence, messaging, third-party APIs, file systems, email/SMS.
- **Non-deterministic**: the **clock** (use {{TimeProvider}}), **randomness**, **id generation** when tests need predictability, environment information.
- **Substituted** for testing or environments: simulators, sandboxes, in-memory.
- **Likely to change technology or vendor**.

### Keep it concrete when it is
- **Pure in-process domain logic**: value objects, domain services, calculators, policies (unless you need runtime selection, then a strategy interface, not a port).
- **Stable libraries** with no I/O used as implementation detail (a math or parsing library) inside the core's own code, if acceptable as a dependency.
- Things with exactly one implementation and no test or environment substitution need.

### Each port is a commitment
It needs an interface, at least two implementations (real and fake/simulator), contract tests, documentation, and maintenance as external systems change. Justify each one.

### Common gaps
Forgetting the clock (tests depend on wall time, flaky at midnight and month-end), and hiding randomness (retry jitter, sampling) inside the core, making behaviour unreproducible.`,
  code: r`~~~csharp
// Time and ids as dependencies make the core deterministic
public interface IIdGenerator { OrderId NewOrderId(); }
internal sealed class GuidV7Ids : IIdGenerator { public OrderId NewOrderId() => new(Guid.CreateVersion7()); }
internal sealed class SequentialTestIds : IIdGenerator { private int _n; public OrderId NewOrderId() => new(new Guid(++_n, 0, 0, new byte[8])); }

public sealed class PlaceOrderService(IOrderStore store, IExchangeGateway exchange, TimeProvider clock, IIdGenerator ids) : IPlaceOrder
{
    public async Task<PlaceOrderResult> ExecuteAsync(PlaceOrderCommand c, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (!TradingHours.IsOpen(c.Instrument.Market, now)) return PlaceOrderResult.Rejected("market.closed");   // testable at any time
        var order = Order.Create(ids.NewOrderId(), c, now);
        /* ... */
        return PlaceOrderResult.Accepted(order.Id);
    }
}

// Concrete, not a port: pure domain calculation
public static class Notional { public static Money Of(decimal qty, Money price) => price.Multiply(qty); }

// Test at a fixed instant: just after market close
var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 12, 16, 30, 1, TimeSpan.FromHours(1)));
~~~`,
  pts: [r`Ports for infrastructure, external systems and non-determinism.`, r`Clock, randomness and ids as ports make the core reproducible.`, r`Pure domain logic stays concrete.`, r`Every port costs implementations, contract tests and maintenance.`, r`Missing clock ports cause flaky time-dependent tests.`],
  ex: r`A settlement core used DateTime.UtcNow directly; tests passed in the morning and failed after 16:00 because of the cut-off rule, and month-end logic had never been tested. Injecting TimeProvider let the team test cut-offs, holidays and month-ends deterministically.`,
  fu: [r`Is ILogger a port?`, r`Should configuration be a port?`, r`How do you make retry jitter reproducible in tests?`],
  pit: [r`Interfaces for pure domain classes.`, r`Wall-clock time in the core.`, r`Hidden randomness.`] },

{ id: 'q6', level: 'Basic', tags: ['hexagonal', 'layered-architecture', 'comparison'],
  q: r`How is hexagonal architecture different from a classic layered (presentation → business → data) architecture, and what concrete problems does that difference solve?`,
  a: r`### Layered architecture
- Dependencies flow **downward**: presentation → business → data access. The business layer **depends on** data access (and often on its types: EF entities, DataSets).
- The database is the foundation; the UI is the top. Other drivers (batch, messages, tests) are bolted on.
- Testing business logic requires the data layer (or mocking it after the fact).

### Hexagonal
- The business core is the **centre**; **everything else is outside**, including the database.
- Dependencies point **inward** on all sides (dependency inversion for driven adapters).
- Drivers are **symmetric**: UI, API, messages, batch and tests are all driving adapters of equal standing.
- The core can run without any infrastructure.

### Problems solved
| Problem in layered systems | Hexagonal answer |
|---|---|
| Business logic leaking into stored procedures, controllers, ORM entities | the core owns rules; adapters translate only |
| Tests need a database | tests drive the core with fake driven adapters |
| A new channel (message queue) duplicates logic | new driving adapter calls the same port |
| Swapping a vendor rewrites business code | swap the driven adapter |
| Database-shaped domain model | the core designs its own model; persistence adapts to it |

### What stays the same
You still have separation of concerns; hexagonal just fixes the direction and symmetry.`,
  code: r`~~~csharp
// Layered: business layer depends on the data layer's types
namespace BusinessLayer
{
    public class OrderManager(OrderDal dal)                 // concrete data-access class
    {
        public void Place(OrderDto dto)
        {
            DataRow row = dal.NewOrderRow();                 // data-layer types in business code
            row["Qty"] = dto.Qty;
            dal.Save(row);
        }
    }
}

// Hexagonal: data access depends on the core's port
namespace Trading.Core { public interface IOrderStore { Task SaveAsync(Order o, CancellationToken ct); } }
namespace Trading.Adapters.Persistence
{
    internal sealed class SqlOrderStore(TradingDbContext db) : Trading.Core.IOrderStore
    {
        public async Task SaveAsync(Order o, CancellationToken ct) { db.Orders.Update(o); await db.SaveChangesAsync(ct); }
    }
}
~~~`,
  pts: [r`Layered: business depends on data access; database is the foundation.`, r`Hexagonal: core at the centre, everything else outside, dependencies inward.`, r`Drivers are symmetric: UI, API, messages, batch and tests.`, r`Solves logic leakage, database-bound tests, channel duplication, vendor lock-in in code.`, r`Separation of concerns remains; direction and symmetry change.`],
  ex: r`A layered claims system's business layer passed DataTables around; adding a message-queue channel duplicated validation in a new "QueueManager". Restructuring as a core with ports let both channels share one implementation and cut defects from divergence.`,
  fu: [r`Is "layered with interfaces" the same as hexagonal?`, r`Where do DTOs live in hexagonal architecture?`, r`Can a layered system migrate to hexagonal incrementally?`],
  pit: [r`Adding interfaces to a layered system without inverting ownership.`, r`Database-shaped domain models.`, r`Logic duplicated per channel.`] },

{ id: 'q7', level: 'Intermediate', tags: ['hexagonal', 'composition-root', 'environments', 'guardrails'],
  q: r`Adapter substitution per environment: production uses the real exchange, UAT a certified simulator, CI an in-memory exchange. How do you wire this, prevent a fake from ever reaching production, and keep the wiring testable?`,
  a: r`### Wiring by configuration, not scattered checks
The composition root reads one setting per port ({{Exchange:Adapter = Fix|Simulator|InMemory}}) and registers the matching adapter. Each adapter project exposes its own registration method with its own options.

### Guardrails
- **Startup validation**: in production, only allowed adapters; any fake or simulator fails startup.
- **Assembly separation**: in-memory and simulator adapters live in projects not referenced by the production host (or only in test hosts), so they cannot be wired accidentally.
- **Health checks** expose which adapter is active (and alerts if it is not the expected one).
- **Configuration validation** for adapter options ({{ValidateOnStart}}).

### Testing the wiring
A test builds the production host configuration and asserts the resolved implementation types; another asserts startup fails with a fake configured in production.

### Lazy connections
Adapters that open connections (FIX sessions, brokers) should connect in a hosted service or lazily, with health checks, so startup does not hang on an unavailable dependency.`,
  code: r`~~~csharp
public static class ExchangeRegistration
{
    public static IServiceCollection AddExchange(this IServiceCollection s, IConfiguration cfg, IHostEnvironment env)
    {
        var adapter = cfg["Exchange:Adapter"] ?? throw new InvalidOperationException("Exchange:Adapter missing");
        if (env.IsProduction() && adapter != "Fix")
            throw new InvalidOperationException($"Adapter '{adapter}' is not allowed in production");

        return adapter switch
        {
            "Fix"       => s.AddFixExchange(cfg.GetSection("Exchange:Fix")),          // Trading.Adapters.Fix
            "Simulator" => s.AddExchangeSimulator(cfg.GetSection("Exchange:Sim")),   // Trading.Adapters.Simulator (not in prod image)
            "InMemory"  => s.AddSingleton<IExchangeGateway, InMemoryExchangeGateway>(),
            _ => throw new InvalidOperationException($"Unknown exchange adapter '{adapter}'")
        };
    }
}

// Wiring test
[Fact]
public void Production_configuration_resolves_real_adapters()
{
    using var host = TestHosts.Build(environment: "Production", config: ProdLikeConfig());
    Assert.IsType<FixExchangeGateway>(host.Services.GetRequiredService<IExchangeGateway>());
    Assert.IsType<SqlOrderStore>(host.Services.CreateScope().ServiceProvider.GetRequiredService<IOrderStore>());
}

[Fact]
public void Fake_adapter_in_production_fails_startup() =>
    Assert.Throws<InvalidOperationException>(() => TestHosts.Build("Production", new() { ["Exchange:Adapter"] = "InMemory" }));
~~~`,
  pts: [r`Choose adapters by configuration in the composition root.`, r`Fail startup if non-production adapters are configured in production.`, r`Keep fakes and simulators out of production images.`, r`Expose the active adapter in health checks.`, r`Test the wiring itself.`],
  ex: r`A UAT configuration file was copied into a production deployment and orders went to the exchange simulator for 25 minutes before anyone noticed. The startup guard and an adapter health check would have failed the deployment at boot.`,
  fu: [r`How do you switch adapters at runtime for a migration?`, r`Where should the simulator live in the repo?`, r`How do you handle adapters needing secrets per environment?`],
  pit: [r`if (IsDevelopment) checks scattered in code.`, r`Fakes compiled into production.`, r`No visibility of the active adapter.`] },

{ id: 'q8', level: 'Intermediate', tags: ['hexagonal', 'test-doubles', 'fakes', 'simulators'],
  q: r`Fakes, stubs, mocks, spies and simulators for driven ports: what is each, which do you prefer for testing a hexagonal core, and why?`,
  a: r`| Double | What | Good for |
|---|---|---|
| **Stub** | returns canned answers | a single fixed scenario |
| **Mock** (interaction verification) | asserts specific calls happened | verifying a side effect that has no observable state (rare) |
| **Spy** | records calls for later assertions | checking what was sent (emails, published events) |
| **Fake** | a working lightweight implementation (in-memory store, in-memory exchange) | most core tests: realistic behaviour, state-based assertions |
| **Simulator** | a fuller, often stateful service mimicking the real system's protocol, latency and failures | integration, performance and UAT environments |

### Preference
**Fakes** for driven ports in core tests:
- Tests assert **outcomes** (order state, stored data, events) rather than call sequences, so they survive refactoring.
- One fake serves hundreds of tests.
- Fakes can model failure modes (reject, timeout, partial fill) via configuration.

Mocks couple tests to implementation details ("called SaveAsync twice") and break on harmless refactors.

### Keeping fakes trustworthy
Fakes live next to the adapters (same owner), pass the **same contract test suite** as the real adapter, and are kept simple.`,
  code: r`~~~csharp
// Fake exchange with configurable behaviour
public sealed class InMemoryExchangeGateway : IExchangeGateway
{
    private readonly Dictionary<OrderId, ExchangeAck> _accepted = new();
    public Func<Order, ExchangeBehaviour> Behaviour { get; set; } = _ => ExchangeBehaviour.Accept;
    public IReadOnlyCollection<OrderId> Sent => _accepted.Keys;

    public Task<ExchangeAck> SendAsync(Order order, CancellationToken ct)
    {
        if (_accepted.TryGetValue(order.Id, out var existing)) return Task.FromResult(existing);       // idempotent like the real one
        return Behaviour(order) switch
        {
            ExchangeBehaviour.Reject => throw new ExchangeRejectedException("price.out_of_band"),
            ExchangeBehaviour.Timeout => throw new ExchangeUnavailableException("timeout"),
            _ => Task.FromResult(_accepted[order.Id] = new ExchangeAck($"EX-{_accepted.Count + 1}"))
        };
    }
}

// State-based core test using the fake
[Fact]
public async Task Exchange_timeout_leaves_order_pending_for_reconciliation()
{
    var exchange = new InMemoryExchangeGateway { Behaviour = _ => ExchangeBehaviour.Timeout };
    var store = new InMemoryOrderStore();
    var core = CoreFactory.Create(store, exchange);
    var result = await core.ExecuteAsync(Commands.Buy("VOD.L", 100, 2.50m), default);
    Assert.Equal(OrderStatus.PendingConfirmation, store.Single().Status);
    Assert.Equal("exchange.unavailable", result.Reason);
}
~~~`,
  pts: [r`Stubs, mocks, spies, fakes and simulators serve different purposes.`, r`Fakes are the default for driven ports in core tests.`, r`Assert outcomes and state, not call sequences.`, r`Fakes model failure modes through configuration.`, r`Fakes pass the same contract tests as real adapters.`],
  ex: r`A team's 900 core tests used mocks verifying exact calls; a refactor that batched two saves broke 300 tests with no behaviour change. Replacing mocks with fakes and state assertions made the suite resilient and halved its size.`,
  fu: [r`When is interaction verification the right tool?`, r`How rich should a fake be?`, r`Who maintains fakes when the real system changes?`],
  pit: [r`Mocks everywhere.`, r`Fakes nobody checks against reality.`, r`Fakes richer than the real system.`] },

{ id: 'q9', level: 'Intermediate', tags: ['hexagonal', 'contract-tests', 'adapters', 'testing'],
  q: r`Write contract tests for a driven port so that the in-memory fake, the simulator and the real adapter all behave the same. What belongs in the contract, and how do you run the suite against systems you do not control?`,
  a: r`### Shape
An **abstract test class** per port defining behaviours every implementation must satisfy; one concrete subclass per adapter supplies the instance. The fake runs in every build; the simulator and real/sandbox adapters run in integration stages or nightly.

### What belongs in the contract
- **Happy-path semantics**: returns an id, persists what was saved, reads back what was written.
- **Business rejections** with reason codes.
- **Idempotency**: sending the same order twice yields the same acknowledgement.
- **Error semantics**: unavailable vs rejected vs not found.
- **Ordering / consistency guarantees** the core relies on.
- **Edge values**: zero, maximum lengths, unicode, decimal precision.

### Systems you do not control
- Run against the vendor's **sandbox** nightly, with test data management and rate limits respected.
- Record responses (golden files) from sandbox runs for fast replay in CI; refresh periodically.
- When the sandbox differs from production (common), document known differences and test them with production canaries.

### When the contract fails
- Real adapter fails but fake passes: the fake is wrong or the vendor changed: fix the fake and the adapter.
- Fake fails: someone changed the fake without updating the contract.`,
  code: r`~~~csharp
public abstract class ExchangeGatewayContract
{
    protected abstract IExchangeGateway CreateGateway();

    [Fact]
    public async Task Rejects_zero_quantity_with_reason()
    {
        var ex = await Assert.ThrowsAsync<ExchangeRejectedException>(() => CreateGateway().SendAsync(TestOrders.WithQuantity(0), default));
        Assert.Equal("quantity.invalid", ex.Reason);
    }

    [Fact]
    public async Task Sending_same_order_twice_returns_same_ack()
    {
        var gw = CreateGateway(); var order = TestOrders.ValidLimitBuy();
        var a = await gw.SendAsync(order, default);
        var b = await gw.SendAsync(order, default);
        Assert.Equal(a.ExchangeOrderId, b.ExchangeOrderId);
    }

    [Fact]
    public async Task Preserves_price_precision()
    {
        var ack = await CreateGateway().SendAsync(TestOrders.ValidLimitBuy(price: 101.12345m), default);
        Assert.Equal(101.12345m, ack.AcceptedPrice);
    }
}

public sealed class InMemoryExchangeContract : ExchangeGatewayContract { protected override IExchangeGateway CreateGateway() => new InMemoryExchangeGateway(); }

[Trait("Category", "Integration")]
public sealed class SimulatorExchangeContract(SimulatorFixture sim) : ExchangeGatewayContract, IClassFixture<SimulatorFixture>
{ protected override IExchangeGateway CreateGateway() => sim.CreateGateway(); }

[Trait("Category", "Sandbox"), Trait("Schedule", "Nightly")]
public sealed class VenueSandboxContract : ExchangeGatewayContract { protected override IExchangeGateway CreateGateway() => SandboxGateways.Venue(); }
~~~`,
  pts: [r`Abstract suite per port, one subclass per adapter.`, r`Contract covers semantics, rejections, idempotency, errors, ordering and edge values.`, r`Fake in every build; simulator and sandbox in later stages.`, r`Record sandbox responses for fast replay; refresh periodically.`, r`A failing contract tells you which side drifted.`],
  ex: r`An exchange changed its rejection code for out-of-band prices; the nightly sandbox contract run failed the next morning, the fake and adapter mapping were updated the same day, and no production orders were mis-handled.`,
  fu: [r`How do you run contract tests against a rate-limited sandbox?`, r`What if the sandbox behaves differently from production?`, r`How is this different from consumer-driven contract testing (Pact)?`],
  pit: [r`Fakes with no contract.`, r`Contract tests only on the happy path.`, r`Never running against the real system.`] },

{ id: 'q10', level: 'Intermediate', tags: ['hexagonal', 'acceptance-tests', 'test-harness', 'bdd'],
  q: r`Cockburn's original motivation was driving the application from automated tests. Design acceptance tests that drive the core through inbound ports (not the UI), readable by business users, and fast enough to run on every commit.`,
  a: r`### Test harness as a primary adapter
Acceptance tests call **inbound ports** directly with in-memory or simulated driven adapters. They exercise real business behaviour end to end inside the hexagon, without HTTP, browsers or databases.

### Readability
- **Given/When/Then** structure in the domain language, using builders: "given an account with a 1,000 limit, when a 1,200 buy order is placed, then it is rejected for risk".
- Optionally Gherkin (Reqnroll, the SpecFlow successor) for business-authored scenarios; or plain C# with expressive helpers (often more maintainable).
- Test names are business statements.

### Speed and coverage
Thousands of scenarios run in seconds because everything is in memory. UI and API tests then only verify the adapters' translation (a handful per endpoint).

### What these tests catch
Rule interactions across use cases, process flows (order → partial fill → cancel remainder), failure handling (exchange timeout, reject), time-dependent behaviour (market open/close via the fake clock).

### Same scenarios, different adapters
Run a subset of the same acceptance scenarios against the simulator or a deployed environment (through the HTTP adapter) to validate wiring: one specification, several drivers.`,
  code: r`~~~csharp
public sealed class OrderLifecycleScenarios
{
    private readonly TradingTestHarness _h = TradingTestHarness.InMemory();

    [Fact]
    public async Task Partially_filled_order_can_be_cancelled_for_the_remainder()
    {
        // Given
        var account = _h.GivenAccount(limit: 100_000m);
        _h.Exchange.WillFill(quantity: 600);
        // When
        var order = await _h.PlaceLimitBuy(account, "VOD.L", qty: 1_000, price: 2.50m);
        await _h.Cancel(order);
        // Then
        _h.Order(order).ShouldBe(OrderStatus.PartiallyFilledCancelled, filled: 600, cancelled: 400);
        _h.Events.ShouldContain<OrderCancelled>(e => e.CancelledQuantity == 400);
    }

    [Fact]
    public async Task Orders_after_market_close_are_rejected()
    {
        _h.Clock.SetLocal(2026, 10, 12, 16, 35, "Europe/London");
        var result = await _h.PlaceLimitBuy(_h.GivenAccount(), "VOD.L", 100, 2.50m);
        result.ShouldBeRejected("market.closed");
    }
}

// The harness wires the real core with in-memory adapters (or the HTTP adapter for smoke runs)
public sealed partial class TradingTestHarness
{
    public static TradingTestHarness InMemory() => new(new InMemoryOrderStore(), new InMemoryExchangeGateway(), new FakeTimeProvider());
}
~~~`,
  pts: [r`Acceptance tests drive inbound ports with in-memory adapters.`, r`Given/When/Then in the domain language; business-readable names.`, r`Thousands of scenarios run in seconds on every commit.`, r`UI/API tests only verify adapter translation.`, r`Reuse scenarios against simulators or deployed environments for wiring checks.`],
  ex: r`A trading team replaced 400 slow Selenium tests (45 minutes, flaky) with 2,600 port-level scenarios (40 seconds) plus 30 API smoke tests; escaped defects in order handling fell by two thirds.`,
  fu: [r`Gherkin or plain C# for acceptance tests?`, r`How do you keep a test harness maintainable?`, r`How do you run the same scenarios against a deployed environment?`],
  pit: [r`Business rules tested only through the UI.`, r`Harnesses that leak adapter details into scenarios.`, r`Unreadable test names.`] },

{ id: 'q11', level: 'Intermediate', tags: ['hexagonal', 'async', 'cancellation', 'error-semantics'],
  q: r`Design port signatures for I/O-bound adapters: async, cancellation, timeouts, and how failures are represented (exceptions vs results, rejected vs unavailable vs unknown outcome).`,
  a: r`### Async by default
If any realistic adapter performs I/O, the port is {{Task}}/{{ValueTask}}-returning. A synchronous port with an async adapter forces sync-over-async (thread-pool starvation).

### Cancellation and deadlines
Every async port method takes a {{CancellationToken}}. The core passes the request's token; adapters apply their own timeouts within the caller's deadline.

### Failure categories the core must distinguish
| Category | Meaning | Core reaction |
|---|---|---|
| **Business rejection** | the other side said no (insufficient funds, invalid price) | domain outcome, no retry |
| **Unavailable** | could not reach or overloaded, nothing happened | retry later, degrade, inform |
| **Unknown outcome** | timeout after sending: it may have happened | record pending, **reconcile** (query by idempotency key), never blindly resend non-idempotent operations |
| **Not found** | | domain-specific |
| **Bug / contract violation** | malformed response | alert, dead-letter |

### Representation
- Results ({{Result<Ack, GatewayError>}}) make outcomes explicit and cheap; or
- Typed exceptions ({{GatewayRejectedException}}, {{GatewayUnavailableException}}, {{OutcomeUnknownException}}).
Either way, the **port contract documents** them and adapters translate vendor-specific errors into these categories.`,
  code: r`~~~csharp
public abstract record GatewayError(string Code)
{
    public sealed record Rejected(string Code, string Reason) : GatewayError(Code);
    public sealed record Unavailable(string Code) : GatewayError(Code);
    public sealed record OutcomeUnknown(string Code, string IdempotencyKey) : GatewayError(Code);
}

public interface IPaymentGateway
{
    /// Idempotent per idempotencyKey. Never throws for expected outcomes.
    Task<Result<CaptureAck, GatewayError>> CaptureAsync(GatewayReference r, Money amount, string idempotencyKey, CancellationToken ct);
    Task<CaptureStatus?> FindCaptureAsync(string idempotencyKey, CancellationToken ct);       // for reconciliation
}

// Core reacts per category
var result = await gateway.CaptureAsync(payment.GatewayRef, amount, captureId.ToString(), ct);
return result.Match(
    ack => payment.ConfirmCapture(captureId, ack.Reference),
    err => err switch
    {
        GatewayError.Rejected r => payment.RejectCapture(captureId, r.Reason),
        GatewayError.Unavailable => payment.MarkCaptureRetryable(captureId),
        GatewayError.OutcomeUnknown => payment.MarkCaptureUnknown(captureId),     // reconciliation job calls FindCaptureAsync
        _ => throw new UnreachableException()
    });
~~~`,
  pts: [r`Async ports when any adapter does I/O; always pass CancellationToken.`, r`Adapters apply timeouts within the caller's deadline.`, r`Distinguish rejected, unavailable, unknown outcome, not found and bugs.`, r`Unknown outcomes require reconciliation, never blind resend.`, r`Document error semantics as part of the port contract.`],
  ex: r`A payment core treated every gateway timeout as a failure and let customers retry; some captures had succeeded, leading to double charges. Modelling OutcomeUnknown with a reconciliation lookup by idempotency key eliminated duplicates.`,
  fu: [r`Results or exceptions: which do you standardise on?`, r`How does the core propagate deadlines to adapters?`, r`What does reconciliation look like for an exchange order?`],
  pit: [r`Synchronous ports over I/O.`, r`Timeouts treated as failures.`, r`Vendor error codes leaking into the core.`] },

{ id: 'q12', level: 'Intermediate', tags: ['hexagonal', 'primary-adapters', 'grpc', 'cli'],
  q: r`The same inbound port must be reachable over REST, gRPC, a CLI for operations, and a FIX acceptor. How do you build these driving adapters consistently (mapping, authentication, errors), without duplicating logic?`,
  a: r`### Principle
Each driving adapter does only: **parse protocol → authenticate → map to command → call port → map result to protocol**. All business behaviour lives behind the inbound port.

### Consistency tools
- A shared **command factory/validator** for input rules common to all channels (or validation inside the core for anything that matters).
- A shared **result-to-protocol mapping** per error category (rejected → HTTP 422 / gRPC FAILED_PRECONDITION / FIX OrderCancelReject or ExecutionReport with reject reason / CLI exit code 2).
- **Identity mapping** per channel into the same {{ICurrentUser}} abstraction (JWT for REST/gRPC, FIX session-to-account mapping, CLI operator via Windows/Entra identity).
- Shared observability: each adapter starts a span with the channel name.

### Channel-specific concerns stay in adapters
FIX session management, sequence numbers and heartbeats; gRPC deadlines and streaming; HTTP idempotency keys and ProblemDetails; CLI argument parsing and confirmation prompts.

### Testing
Core scenarios once (through the port); per adapter, a small set of translation tests (each error category maps correctly, auth works).`,
  code: r`~~~csharp
// REST
app.MapPost("/orders", async (PlaceOrderRequest r, IPlaceOrder port, CancellationToken ct) =>
    OrderResultMapping.ToHttp(await port.ExecuteAsync(r.ToCommand(), ct)));

// gRPC
public sealed class OrdersGrpc(IPlaceOrder port) : Orders.OrdersBase
{
    public override async Task<PlaceOrderReply> Place(PlaceOrderMessage m, ServerCallContext ctx)
    {
        var result = await port.ExecuteAsync(m.ToCommand(), ctx.CancellationToken);
        return result.Accepted ? new PlaceOrderReply { OrderId = result.OrderId.ToString() }
                               : throw new RpcException(OrderResultMapping.ToGrpcStatus(result));
    }
}

// FIX acceptor (QuickFIX/n): NewOrderSingle -> port -> ExecutionReport
public void OnMessage(QuickFix.FIX44.NewOrderSingle nos, SessionID session)
{
    var result = _port.ExecuteAsync(FixMapping.ToCommand(nos, _accounts.For(session)), CancellationToken.None).GetAwaiter().GetResult();
    Session.SendToTarget(FixMapping.ToExecutionReport(nos, result), session);     // engine callback is synchronous: isolate it on its own thread
}

// CLI for operations
var place = new Command("place-order") { accountOpt, symbolOpt, qtyOpt, priceOpt };
place.SetHandler(async (account, symbol, qty, price) =>
{
    var result = await port.ExecuteAsync(new PlaceOrderCommand(account, symbol, Side.Buy, qty, price), CancellationToken.None);
    Environment.ExitCode = OrderResultMapping.ToExitCode(result);
}, accountOpt, symbolOpt, qtyOpt, priceOpt);
~~~`,
  pts: [r`Driving adapters: parse, authenticate, map, call port, map result.`, r`Shared result mappings per error category for each protocol.`, r`Identity mapped per channel into one abstraction.`, r`Channel mechanics (sessions, deadlines, idempotency headers) stay in adapters.`, r`Test core scenarios once; translation tests per adapter.`],
  ex: r`A broker exposed orders via REST, FIX and an ops CLI; before the refactor the CLI bypassed risk checks because it wrote to the database directly. Routing the CLI through the inbound port made every channel enforce the same limits.`,
  fu: [r`How do you map a business rejection into FIX?`, r`How do you secure an operations CLI?`, r`How do you propagate gRPC deadlines into the core?`],
  pit: [r`Channels with their own business logic.`, r`Ops tools writing to databases directly.`, r`Inconsistent error mapping across channels.`] },

{ id: 'q13', level: 'Intermediate', tags: ['hexagonal', 'determinism', 'timeprovider', 'reproducibility'],
  q: r`Make a hexagonal core deterministic and reproducible: time, randomness, ids, concurrency and external data. Why does this matter for testing, debugging and regulators?`,
  a: r`### Sources of non-determinism
| Source | Make it a port |
|---|---|
| Current time | {{TimeProvider}} |
| Random numbers (jitter, sampling, tie-breaks) | {{IRandom}} or a seeded {{Random}} provided by an adapter |
| Identifiers | {{IIdGenerator}} |
| External data (prices, rates, reference data) | driven ports returning snapshots |
| Concurrency/order of events | process inputs in a defined order (single-writer per key), record arrival order |
| Environment (machine name, culture) | configuration passed in, invariant culture in the core |

### Why it matters
- **Tests**: identical inputs produce identical outputs; no flakiness at midnight, month-end or DST changes.
- **Debugging**: reproduce a production incident by replaying recorded inputs with the recorded clock and data.
- **Regulation**: demonstrate that the system behaves as specified on given inputs (e.g. algorithmic trading testing, credit decisions).

### Techniques
- Record the **inputs** of each decision (commands with timestamps, external data snapshots, random seeds) so it can be replayed.
- Keep the core free of {{DateTime.UtcNow}}, {{Guid.NewGuid()}}, {{Random.Shared}} (architecture test or analyzer).
- Use {{FakeTimeProvider}} to move time in tests; time zones explicit.`,
  code: r`~~~csharp
// Analyzer-like architecture test: no ambient non-determinism in the core
[Fact]
public void Core_does_not_use_ambient_time_random_or_guid()
{
    var forbidden = new[] { "System.DateTime::get_UtcNow", "System.DateTime::get_Now", "System.Guid::NewGuid", "System.Random::get_Shared" };
    var offenders = IlScanner.FindCalls(typeof(Trading.Core.Order).Assembly, forbidden);
    Assert.Empty(offenders);
}

// Decision inputs recorded for replay
public sealed record DecisionRecord(Guid DecisionId, DateTimeOffset At, PlaceOrderCommand Command,
                                    RiskSnapshot Risk, MarketSnapshot Market, int RandomSeed, string CoreVersion);

// Replay reproduces the decision exactly
[Theory, MemberData(nameof(RecordedDecisions))]
public async Task Replay_reproduces_recorded_outcomes(DecisionRecord rec, PlaceOrderResult expected)
{
    var core = CoreFactory.ForReplay(clock: new FakeTimeProvider(rec.At), market: Snapshot.Of(rec.Market),
                                     risk: Snapshot.Of(rec.Risk), random: new SeededRandom(rec.RandomSeed));
    var actual = await core.ExecuteAsync(rec.Command, default);
    Assert.Equal(expected, actual);
}
~~~`,
  pts: [r`Time, randomness, ids, external data and ordering are ports or recorded inputs.`, r`Deterministic cores give stable tests and reproducible incidents.`, r`Record decision inputs, including seeds and data snapshots.`, r`Forbid ambient non-determinism in the core with automated checks.`, r`Replay recorded decisions to prove behaviour to regulators.`],
  ex: r`A credit-decisioning engine could not explain why two identical applications got different outcomes; the cause was random tie-breaking in a scorecard. Seeding randomness through a port and recording seeds made every decision replayable and explainable.`,
  fu: [r`How do you handle concurrency when replaying?`, r`What should a decision record contain?`, r`How do you test DST transitions?`],
  pit: [r`Ambient time and randomness in the core.`, r`Unrecorded external data used in decisions.`, r`Culture-dependent formatting in rules.`] },

{ id: 'q14', level: 'Intermediate', tags: ['hexagonal', 'persistence', 'unit-of-work', 'transactions'],
  q: r`Design the persistence side of a hexagon: store ports, unit of work, transactions across several driven ports, and what happens when the core needs both a database write and a message publication.`,
  a: r`### Store ports
Shaped by the core: {{IOrderStore.SaveAsync(order)}}, {{GetAsync(id)}}, plus domain-meaningful finders. Aggregate-oriented, no {{IQueryable}}. Queries for screens go through separate query ports.

### Unit of work
When a use case modifies several aggregates or must commit atomically with an outbox, expose a **unit-of-work port** ({{IUnitOfWork.CommitAsync}}) implemented by the persistence adapter (DbContext). Stores register changes; the use case commits once.

### Database write + message
Two driven ports (store and publisher) cannot share a transaction unless both are the same resource. Options:
1. **Outbox** inside the persistence adapter: the publisher port used by the core is implemented by **writing to the outbox table** in the same unit of work; a relay publishes later. The core only sees {{IEventPublisher.Publish(event)}} with "after commit, at least once" semantics documented.
2. Publish after commit (lossy on crash): only for non-critical notifications.

### Transactions and the core
The core should not manage database transactions directly; it expresses "these changes belong together" through the unit-of-work port. Isolation levels and retries are adapter concerns configured per use case if needed.`,
  code: r`~~~csharp
// Core ports
public interface IOrderStore { Task<Order?> GetAsync(OrderId id, CancellationToken ct); void Add(Order o); }
public interface IEventPublisher { void Publish(IIntegrationEvent e); }        // semantics: delivered at least once, after commit
public interface IUnitOfWork { Task CommitAsync(CancellationToken ct); }

// Persistence adapter implements all three on one DbContext: atomic by construction
internal sealed class EfStore(TradingDbContext db) : IOrderStore, IEventPublisher, IUnitOfWork
{
    public Task<Order?> GetAsync(OrderId id, CancellationToken ct) => db.Orders.SingleOrDefaultAsync(o => o.Id == id, ct);
    public void Add(Order o) => db.Orders.Add(o);
    public void Publish(IIntegrationEvent e) => db.Outbox.Add(OutboxMessage.From(e));          // same transaction as the order
    public Task CommitAsync(CancellationToken ct) => db.SaveChangesAsync(ct);
}
builder.Services.AddScoped<EfStore>();
builder.Services.AddScoped<IOrderStore>(sp => sp.GetRequiredService<EfStore>());
builder.Services.AddScoped<IEventPublisher>(sp => sp.GetRequiredService<EfStore>());
builder.Services.AddScoped<IUnitOfWork>(sp => sp.GetRequiredService<EfStore>());

// Core use case
order.Accept(ack);
publisher.Publish(new OrderAcceptedV1(order.Id.Value, order.Quantity, order.LimitPrice));
await uow.CommitAsync(ct);
~~~`,
  pts: [r`Store ports are aggregate-shaped; queries use separate ports.`, r`A unit-of-work port expresses atomic groups of changes.`, r`Publisher port implemented via outbox in the same transaction.`, r`Document delivery semantics: after commit, at least once.`, r`Isolation and retries are adapter concerns.`],
  ex: r`A team's core called a Kafka publisher port directly after SaveAsync; a crash between them lost 0.1% of OrderAccepted events, breaking downstream settlement. Implementing the publisher port as an outbox write in the same unit of work made delivery reliable without changing the core.`,
  fu: [r`What if the store and publisher must be different technologies?`, r`Who decides isolation levels?`, r`How does the in-memory fake implement the unit of work?`],
  pit: [r`Separate transactions for state and events.`, r`IQueryable in store ports.`, r`Core managing database transactions directly.`] },

{ id: 'q15', level: 'Intermediate', tags: ['hexagonal', 'routing', 'failover', 'composite-adapters'],
  q: r`One port, several real adapters: route payments to Stripe or Adyen by merchant and currency, fail over when one is down, and compare quotes from several venues. How do you implement routing and composite adapters without leaking it into the core?`,
  a: r`### Patterns
- **Routing adapter**: implements the port and delegates to one of several adapters by rule (merchant contract, currency, region, cost).
- **Failover adapter**: tries a primary, switches to a secondary on **unavailable** (never on business rejection or unknown outcome without reconciliation).
- **Composite / fan-out adapter**: calls several adapters and aggregates (best price across venues, first response wins).
- **Decorators** for cross-cutting behaviour (caching, metrics, fault injection).

### Where routing rules belong
- If routing is **technical** (availability, latency), it lives in the adapter layer.
- If routing is a **business decision** (cost optimisation, merchant contracts, regulatory constraints), model it in the core as a policy that **chooses a provider id**, and pass it to a port that accepts the provider explicitly. Hidden business rules in adapters are hard to test and audit.

### Pitfalls
- Failover on ambiguous outcomes creates duplicates: failover only when the request certainly did not reach the provider, or reconcile first.
- Provider-specific references must be stored with the payment so refunds go back to the same provider.
- Lowest-common-denominator ports hide features; allow optional capabilities.`,
  code: r`~~~csharp
// Business routing decided in the core and recorded
public sealed class ProviderSelectionPolicy(IProviderContracts contracts)
{
    public ProviderId Choose(Merchant m, Money amount, PaymentMethod method) =>
        contracts.For(m).Where(c => c.Supports(amount.Currency, method)).MinBy(c => c.CostFor(amount))!.Provider;
}

// Port accepts the chosen provider explicitly; adapter dispatches
public interface IAuthorisationGateway { Task<Result<AuthAck, GatewayError>> AuthoriseAsync(ProviderId provider, AuthRequest r, CancellationToken ct); }

internal sealed class RoutingAuthorisationGateway(IReadOnlyDictionary<ProviderId, IProviderAdapter> adapters) : IAuthorisationGateway
{
    public Task<Result<AuthAck, GatewayError>> AuthoriseAsync(ProviderId p, AuthRequest r, CancellationToken ct) => adapters[p].AuthoriseAsync(r, ct);
}

// Technical failover: only when the request certainly did not reach the primary
internal sealed class FailoverQuoteSource(IQuoteSource primary, IQuoteSource secondary) : IQuoteSource
{
    public async Task<Quote> GetAsync(QuoteRequest r, CancellationToken ct)
    {
        try { return await primary.GetAsync(r, ct); }
        catch (Exception ex) when (ex is BrokenCircuitException or HttpRequestException { HttpRequestError: HttpRequestError.ConnectionError })
        { return await secondary.GetAsync(r, ct); }      // quotes are read-only: safe to fail over
    }
}
~~~`,
  pts: [r`Routing, failover, composite and decorator adapters behind one port.`, r`Technical routing in adapters; business routing as a core policy.`, r`Fail over only when the request certainly did not land.`, r`Store provider references for follow-up operations.`, r`Avoid lowest-common-denominator ports; support optional capabilities.`],
  ex: r`A PSP's failover adapter switched to the secondary provider on timeouts; some authorisations had succeeded at the primary and customers saw double holds on their cards. Restricting failover to connection failures and adding reconciliation fixed it.`,
  fu: [r`How do you route refunds when the original provider is down?`, r`How do you expose a provider-specific feature through a generic port?`, r`How do you test routing rules?`],
  pit: [r`Business routing hidden in adapters.`, r`Failover on ambiguous outcomes.`, r`Losing the provider reference.`] },

{ id: 'q16', level: 'Intermediate', tags: ['hexagonal', 'frontend', 'angular', 'react'],
  q: r`Apply ports and adapters in an Angular or React front end: what is the core, what are the ports (API, storage, analytics, time), and how does it improve testing and backend changes?`,
  a: r`### Core in a front end
UI-independent application logic: state transitions, validation, calculations (fees preview, eligibility hints), workflow steps. Often expressed as services/stores (Angular services with signals, NgRx; React hooks with Zustand/Redux), free of HTTP and browser APIs.

### Driven ports
- **API gateway port** ({{PaymentsApi}}) implemented by a generated HTTP client adapter; a fake for tests and Storybook.
- **Storage** (localStorage, IndexedDB), **analytics**, **feature flags**, **clock**, **navigation**.
### Driving adapters
Components and routes call the core; components stay presentational.

### Benefits
- Unit tests of UI logic without HTTP mocking or DOM.
- Storybook and demos with fake adapters.
- Backend changes (new API version, GraphQL vs REST, BFF) touch the adapter only.
- Offline/mock modes for development.

### Wiring
Angular DI tokens ({{InjectionToken}} with providers per environment); React context providers or module-level factories.`,
  code: r`~~~typescript
// Port (core-owned)
export interface PaymentsPort {
  getPayment(id: string): Promise<Payment>;
  refund(id: string, amount: Money, reason: RefundReason, idempotencyKey: string): Promise<RefundResult>;
}
export const PAYMENTS_PORT = new InjectionToken<PaymentsPort>("PaymentsPort");

// Core service: logic, no HTTP
@Injectable({ providedIn: "root" })
export class RefundFlow {
  private readonly api = inject(PAYMENTS_PORT);
  readonly state = signal<RefundState>({ kind: "idle" });

  async submit(payment: Payment, amount: Money, reason: RefundReason) {
    if (amount.value > payment.refundable.value) { this.state.set({ kind: "invalid", message: "Amount exceeds refundable" }); return; }
    this.state.set({ kind: "submitting" });
    try { this.state.set({ kind: "done", result: await this.api.refund(payment.id, amount, reason, crypto.randomUUID()) }); }
    catch (e) { this.state.set({ kind: "failed", code: toErrorCode(e) }); }
  }
}

// Adapters chosen per environment
providers: [{ provide: PAYMENTS_PORT, useClass: environment.mockApi ? FakePaymentsApi : HttpPaymentsApi }]
~~~`,
  pts: [r`Front-end core: UI-independent state, validation and workflow.`, r`Ports for API, storage, analytics, flags, clock.`, r`Components are driving adapters; keep them presentational.`, r`Fake adapters enable tests, Storybook and offline modes.`, r`Backend protocol changes touch only adapters.`],
  ex: r`A merchant dashboard migrated from REST to a BFF with GraphQL; because components called a PaymentsPort, only the adapter changed and the 600 UI logic tests kept passing unchanged.`,
  fu: [r`How do you share types between generated clients and the port?`, r`Where do optimistic updates belong?`, r`How do you test components with fake adapters?`],
  pit: [r`HTTP calls inside components.`, r`Business logic in templates.`, r`Mocking fetch globally for every test.`] },

{ id: 'q17', level: 'Intermediate', tags: ['hexagonal', 'messaging', 'kafka', 'event-driven'],
  q: r`In an event-driven service, Kafka is both input and output. Model the consumer as a driving adapter and the producer as a driven adapter: ports, message contracts vs domain types, idempotency and offsets.`,
  a: r`### Driving side: consumer adapter
- Deserialises the **message contract** (versioned integration event), maps it to a **command**, calls the inbound port, then **commits the offset** only after the port call succeeded.
- Handles redelivery: commands carry the event id; the core (or an inbox in the persistence adapter) makes processing idempotent.
- Ordering: messages keyed by aggregate id; one partition processed sequentially per key.
- Error policy: business rejection → publish an outcome event and commit; transient → retry; poison → dead-letter topic.

### Driven side: publisher port
- The core publishes **its** events through a port ({{IOrderEvents.Publish(OrderAccepted)}}); the adapter maps to the external contract and writes to the outbox (or produces directly if loss is acceptable).
- Contracts are separate from domain types and versioned; the adapter owns serialisation (Avro/Protobuf/JSON) and schema registry interaction.

### Why separate ports
Consumption and publication have different semantics, scaling and failure handling; the core should not know topics, partitions or offsets.

### Testing
Core scenarios via inbound ports with a spy publisher; consumer adapter tests with Testcontainers Kafka verifying offset handling and dead-lettering.`,
  code: r`~~~csharp
// Driving adapter: consume -> command -> port -> commit
public sealed class TradeBookedConsumer(IConsumer<string, TradeBookedV2> consumer, IServiceScopeFactory scopes, IDeadLetter dlq) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        consumer.Subscribe("trades.booked.v2");
        while (!stop.IsCancellationRequested)
        {
            var cr = consumer.Consume(stop);
            await using var scope = scopes.CreateAsyncScope();
            var port = scope.ServiceProvider.GetRequiredService<IRecordTrade>();
            try
            {
                var result = await port.ExecuteAsync(cr.Message.Value.ToCommand(eventId: cr.Message.Value.EventId), stop);
                // business rejections are recorded as outcomes inside the core; nothing to retry
                consumer.Commit(cr);
            }
            catch (TransientException) { /* do not commit: redelivered after rebalance or seek */ consumer.Seek(cr.TopicPartitionOffset); }
            catch (Exception ex) { await dlq.SendAsync(cr, ex, stop); consumer.Commit(cr); }
        }
    }
}

// Driven port and adapter for publication (via outbox)
public interface IPositionEvents { void Publish(PositionChanged e); }
internal sealed class OutboxPositionEvents(TradingDbContext db) : IPositionEvents
{
    public void Publish(PositionChanged e) =>
        db.Outbox.Add(OutboxMessage.For("positions.changed.v1", key: e.BookId.ToString(), PositionChangedV1.From(e)));
}
~~~`,
  pts: [r`Consumers are driving adapters: map contract to command, call port, then commit.`, r`Producers sit behind a driven publisher port, ideally via outbox.`, r`Contracts are versioned and separate from domain types.`, r`Idempotency by event id; ordering by key.`, r`Business rejection, transient failure and poison messages handled differently.`],
  ex: r`A position service committed Kafka offsets before processing to "avoid duplicates"; a crash lost 2,000 trade events and positions were wrong until the next end-of-day rebuild. Committing after the port call, with idempotent processing, removed the loss.`,
  fu: [r`How do you handle a rebalance mid-processing?`, r`Where does schema registry interaction live?`, r`How do you test consumer adapters?`],
  pit: [r`Committing offsets before processing.`, r`Domain types serialised as message contracts.`, r`Kafka types in the core.`] },

{ id: 'q18', level: 'Intermediate', tags: ['hexagonal', 'background-services', 'channels', 'market-data'],
  q: r`A market-data feed handler and a scheduler drive the core from background services. How do you structure these driving adapters for scopes, backpressure, ordering per instrument and graceful shutdown, while keeping threading out of the core?`,
  a: r`### Structure
- The **feed adapter** owns the connection (socket, vendor SDK), decodes messages and writes them into a **bounded channel** (backpressure; drop or conflate policy for market data where only the latest price matters).
- **Workers** read the channel, partitioned by instrument (one lane per hash) for ordering, create a DI **scope per message or batch**, and call the inbound port.
- The **scheduler adapter** uses {{PeriodicTimer}}/a scheduler library and calls ports with explicit time and a system identity.

### Keep threading out of the core
The core receives one command at a time and is written as ordinary single-threaded logic; concurrency (lanes, channels, locks) lives in adapters. If the core needs per-key serialisation, the adapter provides it.

### Conflation
For prices, a newer tick supersedes older ones: the adapter keeps only the latest per instrument when the consumer falls behind, instead of queueing millions of stale ticks.

### Shutdown
Stop the feed, complete the channel, drain within a deadline, then cancel workers; persist state needed for restart (last sequence numbers).`,
  code: r`~~~csharp
public sealed class MarketDataFeedAdapter(IVendorFeed feed, IServiceScopeFactory scopes, ILogger<MarketDataFeedAdapter> log) : BackgroundService
{
    private const int Lanes = 8;
    private readonly ConcurrentDictionary<string, Tick>[] _latest = Enumerable.Range(0, Lanes).Select(_ => new ConcurrentDictionary<string, Tick>()).ToArray();
    private readonly Channel<string>[] _signals = Enumerable.Range(0, Lanes).Select(_ => Channel.CreateBounded<string>(
        new BoundedChannelOptions(10_000) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true })).ToArray();

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var workers = Enumerable.Range(0, Lanes).Select(i => RunLaneAsync(i, stop)).ToArray();
        await foreach (var tick in feed.StreamAsync(stop))
        {
            var lane = (int)((uint)tick.Symbol.GetHashCode() % Lanes);
            _latest[lane][tick.Symbol] = tick;                         // conflation: keep only the newest per symbol
            _signals[lane].Writer.TryWrite(tick.Symbol);
        }
        foreach (var s in _signals) s.Writer.TryComplete();
        await Task.WhenAll(workers);
    }

    private async Task RunLaneAsync(int lane, CancellationToken stop)
    {
        await foreach (var symbol in _signals[lane].Reader.ReadAllAsync(stop))
        {
            if (!_latest[lane].TryRemove(symbol, out var tick)) continue;   // already processed a newer one
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IApplyPrice>().ExecuteAsync(new ApplyPrice(tick.Symbol, tick.Bid, tick.Ask, tick.At), stop);
        }
    }
}
~~~`,
  pts: [r`Feed and scheduler adapters drive the core from background services.`, r`Bounded channels and conflation provide backpressure for market data.`, r`Lanes per instrument preserve ordering; scope per message.`, r`The core stays single-threaded; concurrency lives in adapters.`, r`Graceful shutdown drains within a deadline and persists sequence state.`],
  ex: r`A pricing service queued every tick during a volatility spike and fell 90 seconds behind, quoting stale prices. Conflating to the latest tick per symbol kept it within 20 ms of the feed with the same hardware.`,
  fu: [r`When is conflation not allowed?`, r`How do you detect gaps in sequence numbers?`, r`How do you test the feed adapter?`],
  pit: [r`Unbounded queues for market data.`, r`Locks inside the core.`, r`One scope for the life of the worker.`] },

{ id: 'q19', level: 'Senior', tags: ['hexagonal', 'port-design', 'granularity', 'isp'],
  q: r`How fine-grained should ports be? Compare one port per external system, per capability, and per use case; discuss interface segregation, chatty ports and evolving a port without breaking adapters.`,
  a: r`### Options
| Granularity | Example | Pros | Cons |
|---|---|---|---|
| **Per external system** | {{ICoreBanking}} with 30 methods | mirrors integration teams | fat, couples unrelated use cases, every fake implements 30 methods |
| **Per capability** | {{IAccountDirectory}}, {{IPostingGateway}}, {{IStatementSource}} | cohesive, small fakes, capabilities can move to different systems | more interfaces |
| **Per use case** | {{IGetBalanceForTransfer}} | minimal | explosion of tiny ports, duplication |

**Default: per capability**, named in the core's language. Several capability ports may be implemented by one adapter class for the same system.

### Chatty vs batch
Design ports for how the core uses them: if a use case processes sets, offer batch methods ({{GetRatesAsync(pairs)}}); otherwise N+1 calls appear across the network.

### Evolving a port
- Adding a method breaks all implementations: prefer adding a **new capability port**, or a default interface method only for genuinely derivable behaviour.
- Changing semantics (idempotency, units) is a breaking change: version the port or introduce a new one and migrate.
- Keep the contract test suite as the definition of the port.

### Smell
A port whose methods are used by disjoint sets of use cases is two ports.`,
  code: r`~~~csharp
// Fat, system-shaped port (avoid)
public interface ICoreBanking
{
    Task<Account> GetAccountAsync(string id); Task PostAsync(Posting p); Task<Statement> GetStatementAsync(string id, DateOnly from);
    Task FreezeAsync(string id); Task<IEnumerable<Customer>> SearchCustomersAsync(string q); /* ...25 more */
}

// Capability ports, possibly implemented by one adapter class
public interface IAccountDirectory { Task<AccountSnapshot?> GetAsync(AccountId id, CancellationToken ct); }
public interface IPostingGateway { Task<PostingAck> PostAsync(Posting p, string idempotencyKey, CancellationToken ct); }
public interface IStatementSource { IAsyncEnumerable<StatementLine> LinesAsync(AccountId id, DateOnly from, CancellationToken ct); }

internal sealed class CoreBankingAdapter(ICoreBankingClient client) : IAccountDirectory, IPostingGateway, IStatementSource { /* ... */
    public Task<AccountSnapshot?> GetAsync(AccountId id, CancellationToken ct) => throw new NotImplementedException();
    public Task<PostingAck> PostAsync(Posting p, string key, CancellationToken ct) => throw new NotImplementedException();
    public IAsyncEnumerable<StatementLine> LinesAsync(AccountId id, DateOnly from, CancellationToken ct) => throw new NotImplementedException();
}

// Batch-shaped where the core works on sets
public interface IFxRates { Task<IReadOnlyDictionary<CurrencyPair, decimal>> GetAsync(IReadOnlyCollection<CurrencyPair> pairs, DateOnly on, CancellationToken ct); }
~~~`,
  pts: [r`Default to capability ports in the core's language.`, r`System-shaped fat ports couple use cases and bloat fakes.`, r`Batch methods where the core works on sets.`, r`Evolve by adding ports or versioning; semantics changes are breaking.`, r`Disjoint method usage means the port should split.`],
  ex: r`A core-banking port with 34 methods had a fake that implemented 9 and threw on the rest; a new use case calling a tenth method passed review and failed in UAT. Splitting into five capability ports made every fake complete and every dependency explicit.`,
  fu: [r`When is a per-use-case port justified?`, r`How do default interface methods help or hurt ports?`, r`How do you migrate consumers from a fat port?`],
  pit: [r`System-shaped god ports.`, r`One-item ports used in loops.`, r`Silent semantic changes.`] },

{ id: 'q20', level: 'Senior', tags: ['hexagonal', 'anti-corruption', 'fix', 'iso8583', 'iso20022'],
  q: r`Driven adapters for financial protocols (FIX to exchanges, ISO 8583 to card schemes, ISO 20022 / SWIFT MT to banks): what does the adapter own, how do you translate semantics, and how do you keep protocol complexity out of the core?`,
  a: r`### What the adapter owns
- **Session/connection mechanics**: FIX logon, heartbeats, sequence numbers, resend requests; ISO 8583 TCP framing, network management messages (echo, sign-on); SWIFT/ISO 20022 file or API transport, signing.
- **Message mapping**: domain command ↔ protocol message (NewOrderSingle, 0100/0110 authorisation, pacs.008 credit transfer).
- **Semantic translation**: protocol status codes and reason codes to core outcomes (FIX OrdStatus/ExecType; ISO 8583 response codes 00, 05, 51, 91; ISO 20022 status reason codes), with **unknown codes failing loudly**.
- **Asynchronous responses** correlated back (execution reports, pacs.002 status reports) and turned into core commands through a driving side of the same adapter.
- **Reconciliation hooks**: status queries, end-of-day files.

### Keeping it out of the core
The core speaks orders, fills, authorisations, transfers. No tags, MTIs or XML elements. Conversions of identifiers (ClOrdID, STAN, end-to-end id) are adapter responsibilities, with mappings persisted by the adapter.

### Testing
Protocol test suites from the venue/scheme (certification scripts), recorded message fixtures, simulators speaking the protocol, contract tests at the port level.`,
  code: r`~~~csharp
// Driven port in core language
public interface ICardAuthorisationNetwork
{
    Task<AuthorisationOutcome> AuthoriseAsync(AuthorisationRequest r, CancellationToken ct);
}

// ISO 8583 adapter: framing, field mapping, response-code translation
internal sealed class Iso8583SchemeAdapter(IIso8583Connection conn, IStanGenerator stan) : ICardAuthorisationNetwork
{
    public async Task<AuthorisationOutcome> AuthoriseAsync(AuthorisationRequest r, CancellationToken ct)
    {
        var msg = new Iso8583Message("0100")
            .Set(2, r.PanToken.ResolveForNetwork())       // PAN only inside the PCI-scoped adapter
            .Set(3, "000000")
            .Set(4, r.Amount.ToMinorUnits().ToString("D12"))
            .Set(11, stan.Next())
            .Set(49, Iso4217.Numeric(r.Amount.Currency));
        var resp = await conn.SendAndReceiveAsync(msg, ct);                     // correlates by STAN
        return resp.Get(39) switch
        {
            "00" => AuthorisationOutcome.Approved(resp.Get(38)),
            "05" => AuthorisationOutcome.Declined("do_not_honour"),
            "51" => AuthorisationOutcome.Declined("insufficient_funds"),
            "91" => AuthorisationOutcome.Unavailable("issuer_unavailable"),
            var code => throw new UnknownResponseCodeException("ISO8583.39", code)
        };
    }
}
~~~`,
  pts: [r`Adapters own sessions, framing, sequence numbers and transport.`, r`Map messages and translate status/reason codes; unknown codes fail loudly.`, r`Correlate asynchronous responses and feed them back as commands.`, r`The core never sees tags, MTIs or XML elements.`, r`Test with certification scripts, fixtures, simulators and port contracts.`],
  ex: r`A card processor embedded ISO 8583 response codes throughout its authorisation logic; adding a second scheme with different code semantics took nine months. A port with explicit outcomes and per-scheme adapters cut the next scheme integration to six weeks.`,
  fu: [r`How do you keep PAN data inside the PCI-scoped adapter?`, r`How do you handle FIX sequence gaps after reconnect?`, r`How do you map ISO 20022 status reports back to payments?`],
  pit: [r`Protocol codes in the core.`, r`Defaulting unknown response codes.`, r`Ignoring asynchronous status messages.`] },

{ id: 'q21', level: 'Senior', tags: ['hexagonal', 'resilience', 'circuit-breaker', 'bulkhead'],
  q: r`Where does resilience (timeouts, retries, circuit breakers, bulkheads, hedging) belong in a hexagonal system, and how does the port contract communicate degraded states to the core?`,
  a: r`### In the adapter
Mechanics are technology-specific: HTTP status semantics, connection errors, vendor rate limits. Put them in the driven adapter (Microsoft.Extensions.Http.Resilience pipelines, Polly):
- **Timeouts**: per attempt and total, within the caller's deadline.
- **Retries**: only for idempotent operations and transient errors, with jitter and a budget.
- **Circuit breaker** per dependency (or per endpoint).
- **Bulkhead**: concurrency limit per dependency so one slow vendor cannot exhaust threads/connections.
- **Hedging** for read-only, latency-sensitive calls.

### In the core: decisions about degradation
The core decides **what to do** when a dependency is unavailable: queue for later, use a cached value with a staleness limit, decline, or approve within a limit (stand-in processing). These are business rules.

### Port contract
Expose explicit outcomes ({{Unavailable}}, {{OutcomeUnknown}}, optionally {{Stale(value, age)}}) rather than leaking Polly or HTTP exceptions. The core can then express policies like "if FX rate is older than 60 seconds, do not quote".

### Avoid
Retries at several layers multiplying load; retries in the core (it does not know idempotency of transport); silent fallbacks that hide outages.`,
  code: r`~~~csharp
// Port communicates freshness and availability explicitly
public abstract record RateLookup
{
    public sealed record Fresh(decimal Rate, DateTimeOffset AsOf) : RateLookup;
    public sealed record Stale(decimal Rate, DateTimeOffset AsOf) : RateLookup;
    public sealed record Unavailable : RateLookup;
}
public interface IFxRates { Task<RateLookup> GetAsync(CurrencyPair pair, CancellationToken ct); }

// Adapter: resilience mechanics + last-known-good fallback flagged as stale
internal sealed class FxRatesAdapter(HttpClient http, ILastKnownRates lastKnown) : IFxRates
{
    public async Task<RateLookup> GetAsync(CurrencyPair pair, CancellationToken ct)
    {
        try
        {
            var r = await http.GetFromJsonAsync<RateDto>($"/rates/{pair}", ct);
            lastKnown.Store(pair, r!.Rate, r.AsOf);
            return new RateLookup.Fresh(r.Rate, r.AsOf);
        }
        catch (Exception ex) when (ex is HttpRequestException or TimeoutRejectedException or BrokenCircuitException)
        {
            return lastKnown.TryGet(pair, out var rate, out var asOf) ? new RateLookup.Stale(rate, asOf) : new RateLookup.Unavailable();
        }
    }
}

// Core: business decision on degraded data
var lookup = await rates.GetAsync(pair, ct);
return lookup switch
{
    RateLookup.Fresh f => Quote.From(f.Rate, spread),
    RateLookup.Stale s when clock.GetUtcNow() - s.AsOf < TimeSpan.FromSeconds(60) => Quote.From(s.Rate, spread * 2),   // widen spread
    _ => Quote.Unavailable("fx.unavailable")
};
~~~`,
  pts: [r`Resilience mechanics live in adapters.`, r`Degradation decisions are business rules in the core.`, r`Ports expose Unavailable, OutcomeUnknown and Stale explicitly.`, r`Retry only idempotent calls, once per stack, with budgets.`, r`Bulkheads per dependency; no silent fallbacks.`],
  ex: r`An FX quoting service silently fell back to cached rates during a feed outage and quoted rates 40 minutes old during a volatile move, losing money on client trades. Exposing Stale with an age and a core rule limiting staleness to 60 seconds turned the next outage into wider spreads, then a clean refusal to quote.`,
  fu: [r`How do you avoid retry storms across layers?`, r`What is stand-in processing in card payments?`, r`How do you test degraded modes?`],
  pit: [r`Polly exceptions leaking into the core.`, r`Silent stale fallbacks.`, r`Retries at every layer.`] },

{ id: 'q22', level: 'Senior', tags: ['hexagonal', 'simulators', 'test-environments', 'fidelity'],
  q: r`Build a simulator for an external system (exchange or payment provider) to use in integration, UAT and performance testing. What fidelity do you need, how is it controlled, and how do you keep it honest?`,
  a: r`### Why
Real external test environments are slow, shared, rate-limited, unavailable at night, and cannot produce rare scenarios on demand (partial fills, late rejects, timeouts, duplicate messages).

### Fidelity checklist
- **Protocol fidelity**: speaks the real protocol (FIX session, ISO 8583, REST with the same schemas), so the real adapter is exercised.
- **Behavioural fidelity**: order book or authorisation logic sufficient for the scenarios: fills, partial fills, cancels, rejects with real reason codes.
- **Timing**: configurable latency distributions, jitter, slow responses, timeouts.
- **Failure injection**: disconnects, sequence gaps, duplicate messages, malformed responses.
- **Determinism**: seedable and scriptable for repeatable tests.

### Control plane
An admin API to set scenarios per test or account ("next 3 orders for account A are rejected with code X", "latency 500 ms for 10 minutes"), and to inspect what was received.

### Keeping it honest
- Contract tests run against the simulator **and** the real sandbox/certification environment.
- Recorded production traffic (sanitised) replayed to compare simulator responses with real ones.
- Owned by the team that owns the adapter; versioned with the venue's protocol versions.

### Uses
CI integration tests, UAT for business users, **performance tests** at production-like volumes, game days.`,
  code: r`~~~csharp
// Simulator control plane (runs as its own container in test environments)
app.MapPost("/scenarios", (ScenarioRequest r, ScenarioStore s) => { s.Add(r); return Results.Accepted(); });
app.MapGet("/received/{account}", (string account, MessageLog log) => log.For(account));

public sealed record ScenarioRequest(string Account, string Behaviour, int Count, int LatencyMs, string? RejectCode, int Seed);

// Simulator order handling honours scenarios and seeded randomness
public ExecutionReport Handle(NewOrderSingle nos)
{
    var scenario = _scenarios.NextFor(nos.Account) ?? Scenario.Default(_seed);
    Thread.Sleep(scenario.LatencyMs);                                  // or a scheduled response for async simulation
    return scenario.Behaviour switch
    {
        "reject"  => ExecutionReports.Reject(nos, scenario.RejectCode ?? "99"),
        "partial" => ExecutionReports.PartialFill(nos, qty: nos.OrderQty / 2),
        "silent"  => null!,                                            // no response: exercises timeout handling
        _          => _book.Match(nos)                                // simple matching against a synthetic book
    };
}

// Test arranges the scenario, then drives the real system through its API
await sim.PostAsJsonAsync("/scenarios", new ScenarioRequest("ACC-1", "partial", Count: 1, LatencyMs: 50, RejectCode: null, Seed: 42));
var order = await api.PlaceOrderAsync("ACC-1", "VOD.L", 1000, 2.50m);
await Eventually(() => api.GetOrderAsync(order.Id), o => o.Status == "PartiallyFilled");
~~~`,
  pts: [r`Simulators give on-demand rare scenarios, timing and failures.`, r`Protocol fidelity so the real adapter is exercised.`, r`A control plane for scenarios, latency and inspection.`, r`Seedable for determinism; contract tests and replays keep it honest.`, r`Used for CI, UAT, performance tests and game days.`],
  ex: r`A broker's integration tests depended on an exchange test environment available only on weekdays and unable to produce partial fills on demand. A FIX simulator with a scenario API ran 600 integration scenarios nightly and found a partial-fill cancel bug the exchange environment had never triggered.`,
  fu: [r`How much order-book logic does an exchange simulator need?`, r`How do you use the simulator for performance testing?`, r`Who owns the simulator?`],
  pit: [r`Simulators that only return success.`, r`No comparison against the real system.`, r`Simulators that bypass the real adapter.`] },

{ id: 'q23', level: 'Senior', tags: ['hexagonal', 'replay-testing', 'golden-master', 'regression'],
  q: r`Design a replay adapter that feeds recorded production inputs into the core for regression testing and incident investigation. Cover recording, sanitisation, determinism and comparison.`,
  a: r`### Recording
- Capture **inputs at the driving ports** (commands with timestamps and correlation ids) and **responses from driven ports** (exchange acks, prices, rates) as they happened.
- Store with the code version and configuration version.
- Sampling vs full capture depends on volume and regulation.

### Sanitisation
Personal data and secrets removed or tokenised consistently (same customer → same token), so scenarios stay realistic and lawful. Keep this in the recording pipeline, reviewed by security.

### Replay
- A **replay driving adapter** submits recorded commands in order.
- **Recorded driven adapters** answer with what the real dependencies returned at that time.
- **FakeTimeProvider** set to the recorded timestamps; recorded random seeds and ids.
- The core runs exactly as in production.

### Comparison
Compare outputs (decisions, events, state) with the recorded production outputs (or with the previous version's replay): differences are either intended changes (documented) or regressions. Store diff reports as release evidence.

### Uses
- **Regression testing** of new versions on real traffic before release.
- **Incident investigation**: reproduce exactly what happened.
- **Regulatory evidence**: show behaviour on historical scenarios.`,
  code: r`~~~csharp
// Recording decorator on a driving port (production)
public sealed class RecordingPlaceOrder(IPlaceOrder inner, IReplayRecorder rec, TimeProvider clock) : IPlaceOrder
{
    public async Task<PlaceOrderResult> ExecuteAsync(PlaceOrderCommand cmd, CancellationToken ct)
    {
        var at = clock.GetUtcNow();
        var result = await inner.ExecuteAsync(cmd, ct);
        rec.Record(new RecordedInteraction("PlaceOrder", at, Sanitiser.Sanitise(cmd), result, Activity.Current?.TraceId.ToString()));
        return result;
    }
}

// Recorded driven adapter (replay)
public sealed class RecordedExchange(ReplayLog log) : IExchangeGateway
{
    public Task<ExchangeAck> SendAsync(Order o, CancellationToken ct) => Task.FromResult(log.NextExchangeResponseFor(o.ClientOrderId));
}

// Replay run comparing new version outputs with recorded outputs
foreach (var interaction in log.Interactions("2026-10-09"))
{
    clock.SetUtcNow(interaction.At);
    var actual = await core.ExecuteAsync(interaction.Command, default);
    if (!OutcomeComparer.Equivalent(interaction.RecordedResult, actual)) diffs.Add(new(interaction, actual));
}
report.Write(diffs);    // reviewed: intended changes vs regressions
~~~`,
  pts: [r`Record driving inputs and driven responses with versions.`, r`Sanitise PII consistently in the recording pipeline.`, r`Replay with recorded adapters, fake clock, seeds and ids.`, r`Compare outputs; classify diffs as intended or regressions.`, r`Use for regression, incident reproduction and regulatory evidence.`],
  ex: r`Before releasing a new risk-check version, a broker replayed a full trading day; the diff report showed 312 orders that would now be rejected because of a unit conversion bug in a new rule, caught before production.`,
  fu: [r`How do you replay when the code calls a driven port that did not exist at recording time?`, r`How much traffic do you record?`, r`How do you handle time-ordering of concurrent inputs?`],
  pit: [r`Recording without sanitisation.`, r`Replays without recorded dependency responses.`, r`Non-deterministic cores that cannot be replayed.`] },

{ id: 'q24', level: 'Senior', tags: ['hexagonal', 'performance', 'low-latency', 'abstractions'],
  q: r`Does the ports-and-adapters boundary cost performance? Quantify it, then explain how ultra-low-latency systems (market data at millions of messages per second) keep the architecture without paying for it.`,
  a: r`### The numbers
- Interface (virtual) dispatch: about a nanosecond; often devirtualised by the JIT (sealed types, dynamic PGO, guarded devirtualisation).
- DI resolution per request: microseconds, once per scope.
- Mapping DTO ↔ domain: allocations of small objects; microseconds.
- Network and database calls: **milliseconds**.
For business systems the boundary is noise.

### Where it can matter
Hot paths processing millions of events per second with microsecond budgets: per-message allocations, interface calls in tight loops, async state machines, and copying data between representations.

### Techniques that keep the architecture
- Keep the **hot loop inside one adapter** or one core component; cross ports at coarser granularity (batches, per instrument rather than per tick).
- **Generic struct adapters**: {{Processor<TSink> where TSink : struct, ISink}} lets the JIT specialise and inline the call (no virtual dispatch, no allocation).
- **Sealed** adapter classes for devirtualisation.
- **Pooled or ref-struct messages** ({{ReadOnlySpan<byte>}} parsing) instead of mapping to new objects.
- Synchronous ports for in-memory, CPU-only paths (no async overhead).
- Measure with BenchmarkDotNet and production profiling before optimising.`,
  code: r`~~~csharp
// Generic struct sink: the JIT specialises Process for each TSink and inlines OnQuote
public interface IQuoteSink { void OnQuote(in Quote q); }

public sealed class FeedDecoder<TSink>(TSink sink) where TSink : struct, IQuoteSink
{
    private TSink _sink = sink;
    public void Process(ReadOnlySpan<byte> packet)
    {
        while (QuoteCodec.TryRead(ref packet, out Quote q))      // no allocation: Quote is a struct
            _sink.OnQuote(in q);                                  // direct call after specialisation
    }
}

public struct BookUpdaterSink(OrderBooks books) : IQuoteSink
{
    public void OnQuote(in Quote q) => books.Apply(in q);
}

// Benchmark: interface vs struct-generic dispatch
[MemoryDiagnoser]
public class SinkBench
{
    private readonly byte[] _packet = TestPackets.Quotes(10_000);
    [Benchmark(Baseline = true)] public void InterfaceSink() => new InterfaceDecoder(new ClassSink()).Process(_packet);
    [Benchmark] public void StructGenericSink() => new FeedDecoder<CountingSink>(new CountingSink()).Process(_packet);
}
~~~`,
  pts: [r`Dispatch, DI and mapping costs are tiny relative to I/O.`, r`Matters only on microsecond hot paths with millions of events.`, r`Cross ports at coarse granularity; keep hot loops inside one component.`, r`Struct-generic adapters, sealed types and span parsing remove overhead.`, r`Measure before optimising.`],
  ex: r`A market-data handler crossed an interface per tick and allocated a quote object each time, causing gen0 GCs every few milliseconds. Switching to struct quotes and a struct-generic sink cut allocations to zero and p99 processing latency from 80 µs to 6 µs, without removing the port.`,
  fu: [r`How does dynamic PGO change the cost of interface calls?`, r`When should a port be synchronous?`, r`How do you benchmark realistically?`],
  pit: [r`Abandoning the architecture for imagined costs.`, r`Per-message mapping on hot paths.`, r`Optimising without measurements.`] },

{ id: 'q25', level: 'Senior', tags: ['hexagonal', 'security', 'authentication', 'secrets'],
  q: r`Security in a hexagonal system: where do authentication, authorization, input sanitisation, secrets, mTLS and PCI/PII scoping live, and how do ports help reduce compliance scope?`,
  a: r`### Placement
| Concern | Where |
|---|---|
| Authentication (tokens, client certs, FIX logon) | driving adapters; mapped to a principal for the core |
| Authorization of operations on resources | core (inbound ports check permissions against loaded data) |
| Input validation of protocol data | driving adapters (shape) + core (invariants) |
| Credentials for external systems, mTLS, API keys | driven adapters, loaded from secret stores |
| Encryption of sensitive fields at rest | persistence adapter |
| Output encoding (HTML, CSV injection) | driving adapters that render |

### Reducing compliance scope with ports
Sensitive data (card numbers, national ids) can be confined to **specific adapters** and a tokenisation service: the core handles **tokens** only. Only the tokenisation adapter and the scheme adapter are in PCI scope; the core and other adapters are not. Ports make that boundary explicit and testable.

### Secrets
Adapters receive credentials via options bound from a vault or use managed identities; the core never sees secrets. Rotation handled in adapters (refresh clients).

### Auditing
Security-relevant events (logins, permission denials, sensitive data access) emitted at adapters and core into an audit port.`,
  code: r`~~~csharp
// Core only handles tokens; PAN never enters it
public sealed record CardToken(string Value);
public interface ICardVault { Task<CardToken> TokeniseAsync(ReadOnlyMemory<char> pan, CancellationToken ct); }   // PCI-scoped adapter

// Driving adapter (PCI-scoped endpoint) tokenises immediately and passes the token inward
app.MapPost("/pay", async (PayRequest r, ICardVault vault, IAuthorisePayment port, CancellationToken ct) =>
{
    var token = await vault.TokeniseAsync(r.Pan.AsMemory(), ct);
    return (await port.ExecuteAsync(new AuthorisePayment(token, r.Amount.ToMoney(), r.MerchantId), ct)).ToHttp();
}).RequireAuthorization("merchant");

// Driven adapter detokenises only inside the scheme connection (PCI scope)
internal sealed class SchemeAdapter(ICardVaultDetokeniser vault, IIso8583Connection conn) : ICardAuthorisationNetwork
{
    public async Task<AuthorisationOutcome> AuthoriseAsync(AuthorisationRequest r, CancellationToken ct)
    {
        using var pan = await vault.DetokeniseAsync(r.Token, ct);      // SecureBuffer zeroed on dispose
        return await SendAsync(pan.Span, r, ct);
    }
    private Task<AuthorisationOutcome> SendAsync(ReadOnlySpan<char> pan, AuthorisationRequest r, CancellationToken ct) => throw new NotImplementedException();
}

// Architecture test: no PAN-shaped types outside PCI-scoped assemblies
[Fact] public void Core_has_no_pan_fields() => Assert.Empty(PciScanner.FindPanLikeMembers(typeof(Payment).Assembly));
~~~`,
  pts: [r`Authenticate in driving adapters; authorize against resources in the core.`, r`Credentials, mTLS and encryption live in driven adapters.`, r`Tokenisation confines sensitive data to specific adapters.`, r`Ports make compliance scope explicit and testable.`, r`Security events go through an audit port.`],
  ex: r`A payment platform had PANs flowing through its core and logs, putting 40 services in PCI scope. Tokenising at the edge adapter and detokenising only in the scheme adapter reduced PCI scope to three components and cut audit effort by 70%.`,
  fu: [r`How do you prove to auditors that PANs never reach the core?`, r`Where do you handle secret rotation?`, r`How do FIX sessions authenticate and map to accounts?`],
  pit: [r`Sensitive data passing through the core.`, r`Secrets in the core's configuration.`, r`Authorization only at the edge.`] },

{ id: 'q26', level: 'Senior', tags: ['hexagonal', 'branch-by-abstraction', 'migration', 'feature-flags'],
  q: r`Migrate from an old payment provider (or legacy core banking) to a new one with zero downtime using branch by abstraction behind a port. Cover dual running, shadow calls, per-segment cut-over and rollback.`,
  a: r`### Steps
1. **Port first**: ensure the core depends on a provider-neutral port; if not, introduce it with the old adapter as the only implementation (no behaviour change).
2. **New adapter** implementing the same port, passing the same **contract tests**.
3. **Shadow mode** (for read-only or simulated operations): call the new adapter in parallel, compare results, never use them. For money-moving operations, shadow against the provider's sandbox or use dry-run/validation endpoints.
4. **Routing adapter** with flags: per merchant segment, currency or percentage; sticky routing so follow-up operations (refunds, captures) go to the provider that handled the original.
5. **Cut-over** gradually; monitor business metrics (approval rates, latency, errors) per provider.
6. **Rollback** by flag; existing transactions keep their provider affinity.
7. **Remove** the old adapter and flag after the last dependent operation window closes (refund windows can be months).

### Data
Provider references stored per transaction; tokens migrated (network tokens or vault migration) where needed.`,
  code: r`~~~csharp
internal sealed class MigratingPaymentGateway(LegacyProviderAdapter legacy, NewProviderAdapter next, IFeatureFlags flags,
                                              IProviderAffinity affinity, IShadowComparer shadow) : IPaymentGateway
{
    public async Task<Result<AuthAck, GatewayError>> AuthoriseAsync(AuthRequest r, CancellationToken ct)
    {
        var mode = flags.Variant("provider-migration", r.MerchantSegment);            // legacy | shadow | new
        if (mode == "new") { var res = await next.AuthoriseAsync(r, ct); affinity.Record(r.PaymentId, Provider.New); return res; }

        var legacyResult = await legacy.AuthoriseAsync(r, ct);
        affinity.Record(r.PaymentId, Provider.Legacy);
        if (mode == "shadow") _ = shadow.CompareAsync(r, legacyResult, () => next.ValidateOnlyAsync(r, CancellationToken.None));   // never moves money
        return legacyResult;
    }

    // Follow-up operations go to the provider that handled the original
    public Task<Result<RefundAck, GatewayError>> RefundAsync(PaymentId id, Money amount, string key, CancellationToken ct) =>
        affinity.For(id) == Provider.New ? next.RefundAsync(id, amount, key, ct) : legacy.RefundAsync(id, amount, key, ct);
}
~~~`,
  pts: [r`Introduce a neutral port first, with no behaviour change.`, r`New adapter passes the same contract tests.`, r`Shadow mode without moving money; compare and fix.`, r`Route by segment with provider affinity for follow-up operations.`, r`Roll back by flag; remove old adapter after dependent windows close.`],
  ex: r`A subscription business migrated 2 million cards between PSPs over three months; provider affinity ensured refunds on old payments still went to the old PSP for the 180-day refund window, and approval-rate monitoring per segment caught a 3DS configuration issue in the first 1% cohort.`,
  fu: [r`How do you migrate stored card tokens?`, r`What metrics decide promotion between cohorts?`, r`When can the old adapter finally be deleted?`],
  pit: [r`Big-bang provider switch.`, r`Shadowing money-moving calls for real.`, r`Losing provider affinity for refunds.`] },

{ id: 'q27', level: 'Senior', tags: ['hexagonal', 'consumer-driven-contracts', 'pact', 'integration-testing'],
  q: r`Port contract tests vs consumer-driven contract testing (Pact) vs provider sandboxes vs recorded fixtures: what does each prove about a driven adapter, and how do you combine them for internal and external dependencies?`,
  a: r`| Technique | Proves | Best for |
|---|---|---|
| **Port contract suite** (same tests for fake and real adapter) | fakes behave like real adapters; adapter honours the port semantics | every driven port |
| **Consumer-driven contracts (Pact)** | the provider API still satisfies what this consumer uses (fields, statuses) | **internal** services owned by other teams, who run the pact verification in their CI |
| **Provider sandbox** | the real external system works end to end | external vendors; nightly, rate-limited |
| **Recorded fixtures** (golden HTTP/protocol exchanges) | adapter translation of real responses, fast and offline | external vendors in CI; refreshed from sandbox runs |
| **Production canaries / synthetic transactions** | production behaviour | critical external flows |

### Combining
- **Internal dependencies**: port contracts (your side) + Pact (their side verifies your expectations before they deploy) → breaking changes caught in the provider's pipeline.
- **External vendors**: port contracts + recorded fixtures in CI + nightly sandbox + production synthetic checks. Vendors will not run your pacts.

### Gaps to know
Sandboxes differ from production; Pact checks shape, not semantics; fixtures go stale. Each layer covers another's blind spot.`,
  code: r`~~~csharp
// Consumer side (our adapter's expectations of the internal Limits service), PactNet v5
var pact = Pact.V4("payments-api", "limits-service", new PactConfig()).WithHttpInteractions();
pact.UponReceiving("a reservation request within limit")
    .Given("account ACC-1 has 1000 GBP available")
    .WithRequest(HttpMethod.Post, "/v1/reservations")
    .WithJsonBody(new { accountId = "ACC-1", amount = 100.00m, currency = "GBP", reference = Match.Type("pay-123") })
    .WillRespond().WithStatus(HttpStatusCode.Created)
    .WithJsonBody(new { reservationId = Match.Type("res-1"), remaining = Match.Decimal(900.00m) });

await pact.VerifyAsync(async ctx =>
{
    var adapter = new HttpLimitsAdapter(new HttpClient { BaseAddress = ctx.MockServerUri });
    var result = await adapter.ReserveAsync(new AccountId("ACC-1"), Money.Gbp(100), "pay-123", default);
    Assert.True(result.IsSuccess);
});
// Pact file published to the broker; limits-service CI verifies it before deploying.

// External vendor: recorded fixture replayed in CI
[Fact]
public async Task Translates_vendor_decline_fixture() =>
    Assert.Equal(AuthorisationOutcome.Declined("insufficient_funds"),
                 await new VendorAdapter(FixtureHttp.From("vendor/decline-51.json")).AuthoriseAsync(TestRequests.Small(), default));
~~~`,
  pts: [r`Port contracts keep fakes and adapters aligned.`, r`Pact for internal providers who verify consumer expectations in their CI.`, r`Sandboxes and recorded fixtures for external vendors.`, r`Production synthetic checks for critical flows.`, r`Layer techniques to cover each other's blind spots.`],
  ex: r`An internal limits team renamed a JSON field; the payments team's pact failed in the limits pipeline before deployment, avoiding an outage that a previous similar rename had caused in production.`,
  fu: [r`Who owns pact verification failures?`, r`How do you keep recorded fixtures fresh?`, r`Can Pact test messaging contracts?`],
  pit: [r`Only happy-path fixtures.`, r`Expecting vendors to run your pacts.`, r`Treating sandbox success as production proof.`] },

{ id: 'q28', level: 'Senior', tags: ['hexagonal', 'api-versioning', 'adapters', 'vendor-changes'],
  q: r`An external provider deprecates API v2 in favour of v3 with different semantics, and another moves from REST to webhooks plus polling. How do ports and adapters absorb these changes, and when does the port itself have to change?`,
  a: r`### Absorbed by the adapter (port unchanged)
- New endpoints, field names, authentication schemes, pagination styles.
- Synchronous responses replaced by **webhooks + polling**: the adapter can present a synchronous-looking port by waiting for a webhook or polling with a timeout, or translate the change into the existing "unknown outcome → reconcile" semantics.
- Different error codes mapping to the same outcome categories.

### Port must change when
- **Semantics change** in a way the core must reason about: an operation that was immediate becomes asynchronous with hours of delay; a new outcome (pending review) appears; idempotency guarantees disappear.
- New capabilities the business wants to use.

### Managing the change
1. Build the v3 adapter alongside v2 behind the same port; contract tests on both.
2. If semantics differ, introduce a **new port version** or extend outcomes ({{Pending}}) and update the core deliberately.
3. Cut over with flags per segment; keep v2 until the vendor's deadline.
4. For webhook-based APIs, add a **driving adapter** (webhook endpoint) that feeds status changes into the core, plus a polling fallback.

### Warning sign
If every vendor version change ripples into the core, the port was shaped like the vendor API.`,
  code: r`~~~csharp
// Port extended deliberately when the new API introduces an asynchronous outcome
public abstract record PayoutOutcome
{
    public sealed record Completed(string Reference) : PayoutOutcome;
    public sealed record Rejected(string Reason) : PayoutOutcome;
    public sealed record Pending(string Reference) : PayoutOutcome;     // new in v3: settles later
}
public interface IPayoutGateway { Task<PayoutOutcome> SendAsync(Payout p, string idempotencyKey, CancellationToken ct); }

// v3 adapter: returns Pending; final status arrives by webhook (driving adapter) or polling
internal sealed class ProviderV3PayoutAdapter(HttpClient http) : IPayoutGateway
{
    public async Task<PayoutOutcome> SendAsync(Payout p, string key, CancellationToken ct)
    {
        using var resp = await http.PostAsJsonAsync("/v3/payouts", V3Payout.From(p, key), ct);
        var body = await resp.Content.ReadFromJsonAsync<V3PayoutResponse>(ct);
        return body!.Status switch
        {
            "processing" => new PayoutOutcome.Pending(body.Id),
            "paid" => new PayoutOutcome.Completed(body.Id),
            "failed" => new PayoutOutcome.Rejected(body.FailureCode ?? "unknown"),
            var s => throw new UnknownVendorStatusException(s)
        };
    }
}

// Webhook driving adapter feeds final status back into the core
app.MapPost("/webhooks/provider/payouts", async (V3Webhook w, IRecordPayoutResult port, CancellationToken ct) =>
{
    await port.ExecuteAsync(new RecordPayoutResult(w.Data.Metadata.PayoutId, w.Data.Status == "paid", w.Data.FailureCode), ct);
    return Results.Ok();
});
~~~`,
  pts: [r`Adapters absorb protocol, field, auth and pagination changes.`, r`Ports change when semantics change (sync to async, new outcomes).`, r`Build new adapter versions side by side with contract tests.`, r`Webhook APIs add a driving adapter plus polling fallback.`, r`Vendor changes rippling into the core signal a vendor-shaped port.`],
  ex: r`When a payouts provider moved from synchronous v2 to asynchronous v3, a team with a vendor-neutral port added a Pending outcome and a webhook adapter in three weeks; a sister team whose core parsed v2 responses needed a two-month rewrite.`,
  fu: [r`How do you secure and deduplicate webhooks?`, r`What if webhooks are lost?`, r`How do you run v2 and v3 in parallel safely?`],
  pit: [r`Vendor-shaped ports.`, r`Hiding real semantic changes from the core.`, r`Webhooks without polling fallback.`] },

{ id: 'q29', level: 'Senior', tags: ['hexagonal', 'fault-injection', 'chaos', 'resilience-testing'],
  q: r`Use the adapter boundary for fault injection: latency, errors, timeouts, duplicate and out-of-order messages. How do you build fault-injecting decorators, control them safely, and turn findings into tests?`,
  a: r`### Fault-injecting decorators
A decorator implements the same port and wraps the real adapter, injecting faults according to configuration:
- **Latency**: fixed or distribution-based delays.
- **Errors**: unavailable, rejected, malformed response.
- **Timeouts with success**: the call succeeds at the provider but the caller sees a timeout (the most dangerous case).
- **Duplicates / reordering** for messaging adapters.
Microsoft.Extensions.Resilience includes chaos strategies (fault, latency, outcome injection) usable in pipelines (Polly v8 Simmy).

### Control
- Enabled only in non-production or tightly scoped production experiments (game days), behind flags with automatic expiry.
- Targeted by tenant, account or percentage.
- Observable: injected faults are tagged in traces and metrics.

### From finding to test
Every bug found by fault injection becomes a deterministic **core test** using a fake configured with the same fault, plus (where relevant) an adapter test. Fault injection explores; tests keep the fix.

### What to look for
Retry storms, missing idempotency (duplicates on timeout-with-success), unbounded queues, missing timeouts, poor user messaging, alerts that do not fire.`,
  code: r`~~~csharp
public sealed class ChaosPaymentGateway(IPaymentGateway inner, IChaosSettings chaos, TimeProvider clock) : IPaymentGateway
{
    public async Task<Result<CaptureAck, GatewayError>> CaptureAsync(GatewayReference r, Money amount, string key, CancellationToken ct)
    {
        var plan = chaos.For("payment-gateway");
        if (plan.LatencyMs > 0) await Task.Delay(plan.LatencyMs, clock, ct);
        if (plan.Roll(plan.UnavailableRate)) return Result.Fail<CaptureAck, GatewayError>(new GatewayError.Unavailable("chaos"));

        var result = await inner.CaptureAsync(r, amount, key, ct);
        if (plan.Roll(plan.TimeoutAfterSuccessRate))
            return Result.Fail<CaptureAck, GatewayError>(new GatewayError.OutcomeUnknown("chaos.timeout_after_success", key));   // provider did capture
        return result;
    }
}

// Registered only when enabled (never in production unless an approved game day)
if (cfg.GetValue<bool>("Chaos:Enabled"))
    builder.Services.Decorate<IPaymentGateway, ChaosPaymentGateway>();

// Finding converted into a deterministic core test
[Fact]
public async Task Timeout_after_success_is_reconciled_not_recaptured()
{
    var gateway = new FakePaymentGateway { TimeoutAfterSuccess = true };
    await Core(gateway).CaptureAsync(TestPayments.Authorised(), Money.Gbp(10));
    await Reconciler(gateway).RunAsync();
    Assert.Equal(1, gateway.CaptureCountFor(TestPayments.LastId));
}
~~~`,
  pts: [r`Fault-injecting decorators wrap real adapters behind the same port.`, r`Inject latency, errors, timeout-after-success, duplicates, reordering.`, r`Strictly controlled, targeted, observable, expiring.`, r`Convert every finding into deterministic tests.`, r`Look for retry storms, idempotency gaps and missing alerts.`],
  ex: r`A game day injecting timeout-after-success into the payment gateway revealed that the mobile app's retry button created a second capture. The fix (idempotency key reuse plus reconciliation) was locked in with a core test, and the next real provider incident caused no duplicates.`,
  fu: [r`How do you run chaos experiments in production safely?`, r`Which faults are most valuable to inject first?`, r`How do you measure the outcome of a game day?`],
  pit: [r`Chaos without observability.`, r`Findings not turned into tests.`, r`Uncontrolled fault injection in production.`] },

{ id: 'q30', level: 'Senior', tags: ['hexagonal', 'batch', 'files', 'idempotency'],
  q: r`A nightly batch imports a bank statement file (camt.053, 200,000 lines), matches payments and posts adjustments. Design it with ports and adapters: file adapters, streaming, restartability, idempotency and performance.`,
  a: r`### Ports
- **Driving**: a batch job adapter (scheduler/CLI) calls an inbound port {{ImportStatement(fileRef)}}.
- **Driven**: {{IStatementSource}} (streams parsed entries from a file store: SFTP, Blob, S3), {{IPaymentMatcher}} data via a query port, {{ILedgerPosting}}, {{IImportProgress}} (checkpoints).

### Streaming
The file adapter parses XML/CSV **incrementally** ({{XmlReader}}, {{PipeReader}}) and yields entries as {{IAsyncEnumerable}}; the core processes in chunks (e.g. 1,000 entries), never loading the whole file into memory.

### Restartability and idempotency
- Each file has an id (hash + name); each entry a stable key (statement id + entry reference).
- Progress checkpoints after each committed chunk; restart resumes from the last checkpoint.
- Postings are idempotent by entry key, so re-processing a chunk after a crash causes no duplicates.
- A file already fully imported is skipped.

### Performance
Batch-shaped driven ports (match 1,000 references in one query; post adjustments in bulk), set-based persistence in the adapter, parallelism across independent accounts if ordering allows.

### Outputs
A reconciliation report (matched, unmatched, adjustments) as a port to a file or notification adapter; metrics for duration and counts.`,
  code: r`~~~csharp
public sealed class ImportStatementHandler(IStatementSource source, IPaymentMatching matching, ILedgerPosting ledger,
                                           IImportProgress progress, IUnitOfWork uow) : IImportStatement
{
    public async Task<ImportSummary> ExecuteAsync(ImportStatement cmd, CancellationToken ct)
    {
        if (await progress.IsCompletedAsync(cmd.FileId, ct)) return ImportSummary.AlreadyImported(cmd.FileId);
        var resumeAfter = await progress.LastCheckpointAsync(cmd.FileId, ct);
        var summary = new ImportSummary(cmd.FileId);

        await foreach (var chunk in source.ReadAsync(cmd.FileRef, resumeAfter, ct).Chunk(1_000))
        {
            var matches = await matching.MatchAsync(chunk.Select(e => e.Reference).ToArray(), ct);   // one query per chunk
            foreach (var entry in chunk)
            {
                var outcome = Reconciliation.Decide(entry, matches.GetValueOrDefault(entry.Reference));   // domain rules
                if (outcome.Adjustment is { } adj) ledger.Post(adj, idempotencyKey: entry.Key);           // idempotent by entry key
                summary.Add(outcome);
            }
            await progress.CheckpointAsync(cmd.FileId, chunk[^1].Key, ct);
            await uow.CommitAsync(ct);                                                                    // chunk + checkpoint atomic
        }
        await progress.CompleteAsync(cmd.FileId, ct);
        await uow.CommitAsync(ct);
        return summary;
    }
}
~~~`,
  pts: [r`Batch job is a driving adapter; files, matching, ledger and progress are driven ports.`, r`Stream and chunk; never load whole files.`, r`Checkpoints and idempotent postings make restarts safe.`, r`Batch-shaped ports and set-based persistence for speed.`, r`Reconciliation report and metrics as outputs.`],
  ex: r`A statement import loaded whole files into memory and posted adjustments one by one; a 2 GB month-end file crashed it at 70% and a rerun duplicated 30,000 adjustments. The streamed, checkpointed, idempotent design resumed cleanly after a forced kill in testing.`,
  fu: [r`How do you handle a corrupted file halfway through?`, r`How do you parallelise safely?`, r`Where do you validate file signatures?`],
  pit: [r`Whole-file loading.`, r`Non-idempotent postings on rerun.`, r`One database call per line.`] },

{ id: 'q31', level: 'Senior', tags: ['hexagonal', 'multi-tenancy', 'tenant-specific-adapters', 'white-label'],
  q: r`A white-label platform serves banks that each bring their own core banking system, KYC vendor and notification channels. How do you select adapters per tenant at runtime, isolate their configuration and failures, and onboard a new bank quickly?`,
  a: r`### Per-tenant adapter resolution
- A **tenant adapter registry** maps (tenant, port) → adapter type + configuration.
- A **routing adapter** per port resolves the tenant from {{ITenantContext}} and delegates to the tenant's adapter instance (cached).
- Each adapter instance has its **own options** (endpoints, credentials from the tenant's vault path, timeouts) and its **own resilience pipeline** (circuit breaker and bulkhead per tenant), so one bank's outage does not affect others.

### Onboarding a bank
1. If its system type already has an adapter (e.g. Temenos T24, Finastra), configuration only.
2. Otherwise write a new adapter passing the port contract suite, plus its fake/simulator for tests.
3. Certification run: the bank's sandbox through contract tests and end-to-end scenarios.
4. Enable per tenant with a flag.

### Isolation
Credentials per tenant; network policies; logging tagged with tenant; data residency per adapter configuration; quotas per tenant.

### Core stays generic
Tenant variability expressed as configuration and adapters; the core never branches on bank names.`,
  code: r`~~~csharp
public sealed record AdapterBinding(string Port, string AdapterType, IConfigurationSection Settings);

internal sealed class TenantAccountDirectory(ITenantContext tenant, ITenantAdapterRegistry registry) : IAccountDirectory
{
    public Task<AccountSnapshot?> GetAsync(AccountId id, CancellationToken ct) =>
        registry.Resolve<IAccountDirectory>(tenant.TenantId).GetAsync(id, ct);
}

internal sealed class TenantAdapterRegistry(IServiceProvider sp, ITenantBindings bindings, ResiliencePipelineRegistry<string> pipelines)
    : ITenantAdapterRegistry
{
    private readonly ConcurrentDictionary<(TenantId, Type), object> _cache = new();
    public T Resolve<T>(TenantId tenant) where T : class =>
        (T)_cache.GetOrAdd((tenant, typeof(T)), key =>
        {
            var b = bindings.For(key.Item1, typeof(T).Name);
            var pipeline = pipelines.GetPipeline($"{key.Item1}:{typeof(T).Name}");       // breaker + bulkhead per tenant and port
            return AdapterFactory.Create(sp, b.AdapterType, b.Settings, pipeline);       // e.g. "T24AccountDirectory"
        });
}

// Onboarding = configuration when the system type is known
// tenants/bank-x.json: { "IAccountDirectory": { "type": "T24AccountDirectory", "baseUrl": "...", "vaultPath": "tenants/bank-x/t24" } }
~~~`,
  pts: [r`Registry maps tenant and port to adapter type and configuration.`, r`Routing adapters resolve per tenant; instances cached.`, r`Per-tenant options, credentials and resilience pipelines isolate failures.`, r`Known system types onboard by configuration; new ones need adapter + contract tests.`, r`The core never branches on tenant names.`],
  ex: r`A banking-as-a-service platform onboarded its fourth bank in nine days because the bank used a core system already covered by an adapter; the earlier per-bank code branches had taken four months each. Per-tenant circuit breakers kept one bank's core outage from affecting the others.`,
  fu: [r`How do you test 20 tenant configurations?`, r`How do you rotate one tenant's credentials?`, r`How do you handle tenant-specific capabilities a port does not model?`],
  pit: [r`Bank-specific branches in the core.`, r`Shared circuit breakers across tenants.`, r`Credentials in shared configuration.`] },

{ id: 'q32', level: 'Senior', tags: ['hexagonal', 'testing-strategy', 'test-pyramid', 'economics'],
  q: r`Lay out the testing strategy that hexagonal architecture enables (core scenarios, adapter integration, contract, end-to-end) with proportions, run times and what each layer is responsible for catching.`,
  a: r`| Layer | Drives | Doubles | Catches | Volume / time |
|---|---|---|---|---|
| **Domain unit + property tests** | domain objects | none | rule errors, edge cases | thousands, seconds |
| **Core scenario tests** (through inbound ports) | inbound ports | in-memory fakes, fake clock | rule interactions, workflows, failure handling | hundreds to thousands, seconds |
| **Port contract tests** | driven adapters | real dependency (container, simulator, sandbox) | adapter semantics, fake drift | tens per port, minutes |
| **Driving adapter tests** | HTTP/gRPC/consumer | fake core or real core with fakes | mapping, auth, serialisation, error translation | tens per adapter |
| **Integration with simulators** | deployed system | simulators | wiring, configuration, timing | dozens, nightly |
| **End-to-end / synthetic in production** | real system | none | environment and vendor reality | few, continuous |

### Responsibilities, not duplication
Business rules are tested once, at the core level. Adapter tests do not re-test rules; they verify translation. End-to-end tests verify that pieces are connected, not every rule.

### Economics
Fast inner layers give feedback in under a minute on every commit; slower layers run in parallel stages or nightly. Teams that test rules through the UI pay 10 to 100 times more runtime and flakiness for the same coverage.`,
  code: r`~~~yaml
# Pipeline stages aligned with the pyramid
stages:
  - name: fast
    run: dotnet test --filter "Category!=Integration&Category!=Sandbox&Category!=E2E"   # domain + core scenarios + fakes' contracts (~60 s)
  - name: integration
    run: dotnet test --filter "Category=Integration"                                     # adapters vs containers/simulators (~6 min, parallel)
  - name: nightly
    schedule: "0 2 * * *"
    run: dotnet test --filter "Category=Sandbox|Category=E2E"                            # vendor sandboxes, end-to-end with simulators
~~~
~~~csharp
// Adapter test verifies translation only, not rules
[Fact]
public async Task Rejection_maps_to_422_with_code()
{
    await using var app = new ApiFactory().WithCore(FakeCore.Rejecting("risk.limit"));
    var resp = await app.CreateClient().PostAsJsonAsync("/orders", TestRequests.Buy());
    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    Assert.Equal("risk.limit", (await resp.Content.ReadFromJsonAsync<ProblemDetails>())!.Extensions["code"]!.ToString());
}
~~~`,
  pts: [r`Rules tested once at domain and core-scenario level.`, r`Contract tests per driven port against real dependencies.`, r`Driving adapter tests verify translation, auth and serialisation.`, r`Simulator integration nightly; few end-to-end and synthetic checks.`, r`Fast inner layers give sub-minute feedback.`],
  ex: r`A team's suite took 50 minutes because rules were tested through HTTP against a shared database. Restructuring along the pyramid gave a 70-second fast stage covering 90% of rules and a 7-minute integration stage, while escaped defects fell.`,
  fu: [r`How do you prevent rules being re-tested at every layer?`, r`What belongs in production synthetic checks?`, r`How do you measure test effectiveness?`],
  pit: [r`Rules tested through the UI.`, r`No contract tests, so fakes drift.`, r`One slow monolithic test stage.`] },

{ id: 'q33', level: 'Senior', tags: ['hexagonal', 'audit', 'observability', 'compliance'],
  q: r`Audit trail vs telemetry in a hexagonal system: should audit be a port? Where are audit records produced, how are they kept tamper-evident, and how is this different from logging and tracing?`,
  a: r`### Different purposes
| | Audit | Telemetry (logs, traces, metrics) |
|---|---|---|
| Purpose | legal/regulatory evidence of who did what, when, why | operations and debugging |
| Completeness | **must not lose records** | sampling acceptable |
| Retention | years | days to months |
| Content | business facts, actors, before/after, reasons | technical detail |
| Access | restricted, read by auditors | engineers |

### Audit as a port
Yes: the core produces audit records as **business outputs** through an {{IAuditTrail}} port, because what to audit is a business rule ("every limit change with maker, checker and reason"). The adapter writes them **in the same transaction** as the change (or via outbox) to an append-only store.

### Tamper evidence
- Append-only tables with permissions that forbid update/delete.
- Hash chaining (each record includes the hash of the previous) or database ledger tables (SQL Server ledger) or WORM storage (immutable blob containers).
- Periodic digest publication to an external store.

### Telemetry stays ambient
Tracing and metrics via decorators and auto-instrumentation in adapters; not routed through business ports.`,
  code: r`~~~csharp
public interface IAuditTrail { void Record(AuditEntry entry); }       // same unit of work as the change

public sealed record AuditEntry(string Action, string ResourceType, string ResourceId, UserId Actor,
                                string? Reason, object? Before, object? After, DateTimeOffset At, string CorrelationId);

// Core decides what is auditable
public async Task<Result> Handle(ChangeLimit cmd, CancellationToken ct)
{
    var account = await accounts.GetAsync(cmd.AccountId, ct);
    var before = account!.Limit;
    account.ChangeLimit(cmd.NewLimit, approvedBy: cmd.Checker);
    audit.Record(new AuditEntry("limit.changed", "Account", account.Id.ToString(), cmd.Maker, cmd.Reason,
                                before, account.Limit, clock.GetUtcNow(), Activity.Current?.TraceId.ToString() ?? ""));
    await uow.CommitAsync(ct);
    return Result.Ok();
}

// Adapter: append-only with hash chaining
internal sealed class HashChainedAuditTrail(AuditDbContext db, IAuditChainHead head) : IAuditTrail
{
    public void Record(AuditEntry e)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(e);
        var hash = SHA256.HashData([.. head.Current, .. payload]);
        db.AuditRecords.Add(new AuditRecord(e, payload, previousHash: head.Current, hash));
        head.Advance(hash);
    }
}
~~~`,
  pts: [r`Audit is evidence; telemetry is operations: different guarantees.`, r`Audit is a core output through a port, written atomically with the change.`, r`Append-only storage, hash chains, ledger tables or WORM for tamper evidence.`, r`Telemetry stays ambient via decorators and instrumentation.`, r`What to audit is a business rule.`],
  ex: r`A bank's audit trail was built from application logs; during an investigation, log sampling and a retention policy meant 8% of limit changes had no record. Moving audit to a transactional port with an append-only, hash-chained store closed the gap.`,
  fu: [r`How do you prove an audit trail has not been altered?`, r`How do you handle audit for read access to sensitive data?`, r`What about GDPR and audit retention?`],
  pit: [r`Audit from logs.`, r`Audit written outside the transaction.`, r`Mutable audit tables.`] },

{ id: 'q34', level: 'Senior', tags: ['hexagonal', 'reference-data', 'snapshots', 'caching'],
  q: r`The core needs reference data (instruments, holiday calendars, FX rates, fee schedules) from external sources. Design the driven ports for consistency (point-in-time snapshots), caching, staleness and reproducibility.`,
  a: r`### Port design
- Ask for data **as of** a point in time: {{GetCalendarAsync(market, asOf)}}, {{GetFeeScheduleAsync(merchantTier, effectiveOn)}}. This makes decisions reproducible and testable.
- Return **versioned snapshots** (version id, as-of timestamp) so decisions can record which version they used.
- Batch-shaped methods for sets ({{GetInstrumentsAsync(isins)}}).

### Consistency
Within one use case, use **one snapshot** for all lookups (a rates snapshot for the whole quote), not separate live calls that may straddle an update.

### Caching and staleness
Reference data changes rarely: adapters cache aggressively with **explicit staleness limits** and refresh on change events. The port can expose freshness so the core decides (refuse to price with rates older than N seconds).

### Reproducibility
Recorded snapshot versions allow replaying a decision with the exact data used, critical for disputes and regulators.

### Sources
Reference-data context publishing events; vendor feeds (Bloomberg, Refinitiv) behind ACL adapters; internal tables for fee schedules managed through governed UIs.`,
  code: r`~~~csharp
public sealed record CalendarSnapshot(string Market, string Version, IReadOnlySet<DateOnly> Holidays, DateTimeOffset LoadedAt);
public interface IMarketCalendars { Task<CalendarSnapshot> GetAsync(string market, DateOnly asOf, CancellationToken ct); }

public sealed record RatesSnapshot(string Version, DateTimeOffset AsOf, IReadOnlyDictionary<CurrencyPair, decimal> Rates);
public interface IFxRateSnapshots { Task<RatesSnapshot> CurrentAsync(CancellationToken ct); Task<RatesSnapshot> ByVersionAsync(string version, CancellationToken ct); }

// Use case: one snapshot for the whole decision, version recorded for replay
public async Task<Quote> Handle(PriceCrossBorderPayment cmd, CancellationToken ct)
{
    var rates = await fx.CurrentAsync(ct);
    if (clock.GetUtcNow() - rates.AsOf > TimeSpan.FromSeconds(30)) return Quote.Unavailable("fx.stale");
    var calendar = await calendars.GetAsync(cmd.TargetMarket, cmd.RequestedDate, ct);
    var valueDate = SettlementDates.Next(cmd.RequestedDate, calendar, cutOff: cmd.CutOff);
    var quote = QuoteCalculator.Calculate(cmd, rates, valueDate);
    return quote with { RatesVersion = rates.Version, CalendarVersion = calendar.Version };   // reproducible
}
~~~`,
  pts: [r`Ask for reference data as of a point in time.`, r`Versioned snapshots; record versions with decisions.`, r`One snapshot per decision for consistency.`, r`Aggressive caching with explicit staleness exposed to the core.`, r`Vendor feeds behind ACL adapters.`],
  ex: r`A cross-border quote used two separate live rate calls for the two legs; an update between them produced an arbitrageable quote for 200 ms windows that a client exploited. Using one versioned rates snapshot per quote closed the gap.`,
  fu: [r`How do you invalidate cached calendars when a new holiday is announced?`, r`How do you replay a quote from last year?`, r`What if the reference-data source is down at startup?`],
  pit: [r`Multiple live lookups within one decision.`, r`Unversioned reference data.`, r`Hidden staleness.`] },

{ id: 'q35', level: 'Senior', tags: ['hexagonal', 'legacy-database', 'shared-database', 'anti-corruption'],
  q: r`The new core must read and write a legacy database shared with other applications (cryptic schema, triggers, stored procedures you cannot change). How do you build the persistence adapter so the core's model stays clean and the legacy constraints are respected?`,
  a: r`### Adapter as anti-corruption layer
- The core defines its ports ({{IPolicyStore}}) and model; the adapter maps between the domain model and legacy tables explicitly (a **separate persistence model** is justified here).
- Use the legacy **stored procedures** where other systems depend on their side effects (triggers, audit), rather than writing tables directly.
- Translate codes, flags and units; validate legacy data on read (corrupt rows → explicit errors or quarantine, not silent defaults).

### Concurrency and transactions
- Legacy apps may update the same rows: use the legacy concurrency mechanism (timestamps, version columns) or add optimistic checks in the adapter.
- Keep transactions short; respect lock ordering conventions of the legacy system to avoid deadlocks with other apps.

### Change strategy
- Characterisation tests on the adapter with a copy of the legacy database (Testcontainers with a restored backup or scripted schema).
- Over time, move the data to a database owned by the new core, with synchronisation back to the legacy schema until consumers migrate (strangler).

### What the core must never do
Know table names, flag columns or procedure names; work around legacy quirks in business code.`,
  code: r`~~~csharp
// Port in the core's language
public interface IPolicyStore { Task<Policy?> GetAsync(PolicyNumber n, CancellationToken ct); Task SaveAsync(Policy p, CancellationToken ct); }

// Legacy adapter: explicit mapping, stored procedures, code translation, concurrency
internal sealed class LegacyPolicyStore(SqlConnection conn) : IPolicyStore
{
    public async Task<Policy?> GetAsync(PolicyNumber n, CancellationToken ct)
    {
        var row = await conn.QuerySingleOrDefaultAsync<PolMstRow>(
            new CommandDefinition("dbo.usp_POL_MST_GET", new { POL_NO = n.Value }, commandType: CommandType.StoredProcedure, cancellationToken: ct));
        if (row is null) return null;
        return PolicyLegacyMapper.ToDomain(row);                 // "S"/"L"/"X" status codes, YYYYMMDD ints, pence as strings
    }

    public async Task SaveAsync(Policy p, CancellationToken ct)
    {
        var parms = PolicyLegacyMapper.ToProcParams(p);          // includes the legacy row timestamp for optimistic check
        var affected = await conn.ExecuteAsync(new CommandDefinition("dbo.usp_POL_MST_UPD", parms, commandType: CommandType.StoredProcedure, cancellationToken: ct));
        if (affected == 0) throw new ConcurrencyConflictException($"Policy {p.Number} changed by another system");
    }
}

// Characterisation test against a restored legacy schema in a container
[Fact, Trait("Category", "Integration")]
public async Task Round_trips_policy_with_endorsements() { /* load fixture row, map, save, compare legacy columns */ }
~~~`,
  pts: [r`The adapter is an ACL with an explicit persistence model.`, r`Use legacy stored procedures where other systems rely on their side effects.`, r`Translate codes and validate legacy data on read.`, r`Respect legacy concurrency and lock ordering.`, r`Characterisation tests; strangle the data out over time.`],
  ex: r`A new policy-administration core wrote directly to legacy tables and bypassed a trigger that fed the actuarial system; reserves were mis-stated for a month. Switching the adapter to the legacy update procedure restored the downstream feed while the core's model stayed clean.`,
  fu: [r`How do you test against a legacy schema in CI?`, r`How do you handle corrupt legacy rows?`, r`How do you eventually move the data out?`],
  pit: [r`Legacy column names in the domain.`, r`Writing tables directly and bypassing triggers others depend on.`, r`Silent defaults for unknown codes.`] },

{ id: 'q36', level: 'Senior', tags: ['hexagonal', 'observability', 'decorators', 'dependency-metrics'],
  q: r`Instrument a hexagon: per-port dependency metrics, traces across driving and driven adapters, and health checks, using decorators so neither the core nor every adapter repeats the same code.`,
  a: r`### What to measure
- **Driving side**: request rate, latency, outcome per inbound port and channel.
- **Driven side**: per port and adapter: call rate, latency histogram, error category (rejected/unavailable/unknown), circuit state, retries.
- **Business**: domain events counted (orders accepted, rejected by reason).

### Decorators
A generic instrumentation decorator per port (or a source-generated one) records metrics and spans around every call, tagging port name, adapter name, and outcome category from the port's result type. Registered in the composition root, so adapters stay focused on translation.

### Traces
Driving adapters continue incoming trace context (HTTP headers, message headers); driven adapters propagate it (HTTP, Kafka headers). Spans named by port operation ({{IExchangeGateway.SendAsync}}) make dependency maps readable.

### Health
Health checks per driven adapter (connection status, last successful call), distinguishing **liveness** (process OK) from **readiness** (critical dependencies reachable). Report which adapter implementation is active.

### Dashboards
One per port: latency, errors by category, circuit state, and the business metric it affects.`,
  code: r`~~~csharp
public sealed class InstrumentedExchangeGateway(IExchangeGateway inner, string adapterName) : IExchangeGateway
{
    private static readonly ActivitySource Source = new("Trading.Ports");
    private static readonly Histogram<double> Latency = new Meter("Trading.Ports").CreateHistogram<double>("port.latency_ms");

    public async Task<ExchangeAck> SendAsync(Order order, CancellationToken ct)
    {
        using var span = Source.StartActivity("IExchangeGateway.SendAsync", ActivityKind.Client);
        span?.SetTag("adapter", adapterName);
        var sw = Stopwatch.StartNew(); var outcome = "ok";
        try { return await inner.SendAsync(order, ct); }
        catch (ExchangeRejectedException) { outcome = "rejected"; throw; }
        catch (ExchangeUnavailableException) { outcome = "unavailable"; throw; }
        finally
        {
            span?.SetTag("outcome", outcome);
            Latency.Record(sw.Elapsed.TotalMilliseconds, new("port", "IExchangeGateway"), new("adapter", adapterName), new("outcome", outcome));
        }
    }
}

builder.Services.Decorate<IExchangeGateway>((inner, sp) => new InstrumentedExchangeGateway(inner, inner.GetType().Name));
builder.Services.AddHealthChecks().AddCheck<ExchangeSessionHealthCheck>("exchange-session", tags: ["ready"]);
~~~`,
  pts: [r`Measure per inbound port, per driven port and adapter, and business events.`, r`Instrumentation decorators avoid repeating code in adapters.`, r`Propagate trace context through every adapter.`, r`Readiness reflects critical dependencies; report active adapters.`, r`Dashboards per port tied to business impact.`],
  ex: r`A trading desk's latency complaints were hard to localise until per-port decorators showed the risk-limits adapter adding 40 ms p99 because of a missing connection pool; the fix took an hour once the dashboard existed.`,
  fu: [r`Can you source-generate instrumentation decorators?`, r`What tags should port metrics have?`, r`How do readiness checks avoid cascading failures?`],
  pit: [r`Instrumentation code copied into every adapter.`, r`No outcome categories in metrics.`, r`Liveness checks that test dependencies.`] },

{ id: 'q37', level: 'Principal', tags: ['hexagonal', 'trading', 'regulation', 'capstone'],
  q: r`Capstone: design a regulated trading execution engine (orders from FIX clients and a web UI, risk checks, routing to exchanges, full audit). Regulators require reproducible testing of order handling and you cannot test against live exchanges.`,
  a: r`### Core
Order lifecycle state machine, pre-trade risk rules, routing decisions, execution handling. Pure and **deterministic**: {{TimeProvider}}, seeded randomness, snapshot-based reference data, single-writer per order book or per account.

### Driving adapters
- FIX acceptor (QuickFIX/n) for client order flow.
- REST/gRPC for the web UI and internal systems.
- **Replay adapter** feeding recorded order flow with recorded timestamps.
- Test harness for scenarios.
- Scheduler for session events (market open/close, end-of-day cancels).

### Driven adapters
- Exchange gateways per venue: real FIX, **certified simulator**, in-memory.
- Market data, reference data (instruments, calendars), risk limits store.
- Order store, **append-only audit** with hash chaining, outbox for downstream (post-trade, regulatory reporting).

### Environments
Production: real venues; UAT: venue simulators and certification environments; CI: in-memory. Composition roots per environment with startup guardrails; contract tests across every venue adapter.

### Regulatory testing (e.g. MiFID II algorithmic trading testing)
- Replay recorded production order flow plus stress scenarios (bursts, disorderly markets, venue disconnects) through the replay adapter against simulators.
- Fixed clock and seeds give **deterministic, repeatable** results compared with golden outputs; diffs reviewed and signed off.
- Kill-switch and throttles tested as scenarios.
- Evidence (inputs, versions, outputs, diffs) archived per release.`,
  dia: r`flowchart LR
  FIXC[FIX acceptor] --> PORTS((Inbound ports))
  WEB[REST and gRPC] --> PORTS
  REPLAY[Replay adapter] --> PORTS
  SCHED[Session scheduler] --> PORTS
  PORTS --> CORE[Deterministic core: lifecycle, risk, routing]
  CORE --> EX((IExchangeGateway))
  CORE --> MD((IMarketData))
  CORE --> AUD((IAuditTrail))
  CORE --> ST((IOrderStore))
  EX -.-> REAL[Venue FIX adapters]
  EX -.-> SIM[Certified simulators]
  EX -.-> MEM[In-memory exchange]
  AUD -.-> CHAIN[Append-only hash-chained store]`,
  code: r`~~~csharp
// Regulatory replay test: recorded flow + stress scenario, deterministic, compared with golden output
[Theory, MemberData(nameof(RegulatoryScenarios))]
public async Task Algo_order_handling_matches_signed_off_results(RegulatoryScenario s)
{
    var clock = new FakeTimeProvider(s.StartAt);
    var exchange = new ExchangeSimulator(s.VenueBehaviour, seed: s.Seed);
    var engine = EngineFactory.Create(clock, exchange, MarketDataReplay.From(s.MarketData), RiskLimits.From(s.Limits), new SeededRandom(s.Seed));

    await foreach (var input in s.Inputs)                      // recorded or synthetic: orders, cancels, venue disconnects
    {
        clock.SetUtcNow(input.At);
        await engine.HandleAsync(input, default);
    }

    var output = engine.Outputs();                             // executions, rejections, kill-switch activations, audit
    Golden.AssertMatches($"regulatory/{s.Name}.json", output);  // diffs require sign-off
}

// Kill switch as an explicit core capability, driven by an inbound port
public interface IKillSwitch { Task ActivateAsync(KillScope scope, string reason, UserId by, CancellationToken ct); }
~~~`,
  pts: [r`Deterministic core: time, randomness, data snapshots, single-writer processing.`, r`Driving adapters include FIX, APIs, replay and scheduler.`, r`Venue adapters: real, certified simulator, in-memory, with contract tests.`, r`Replay plus stress scenarios against simulators with golden outputs.`, r`Archived evidence per release; kill switch tested as a scenario.`],
  ex: r`A broker's annual algo-trading self-assessment previously took six weeks of manual testing in shared venue test environments. After building replay and simulator adapters, the same evidence pack was generated in a day per release, and two behaviour changes were caught in diffs before go-live.`,
  fu: [r`How do you keep simulators certified against venue changes?`, r`How do you replay concurrent flows deterministically?`, r`What does the evidence pack contain?`],
  pit: [r`Non-deterministic cores that cannot be replayed.`, r`Testing only against shared venue environments.`, r`Audit from logs.`] },

{ id: 'q38', level: 'Principal', tags: ['hexagonal', 'governance', 'port-design', 'standards'],
  q: r`Across a platform with 30 services, how do you govern which dependencies become ports, how ports are designed and documented, and how adapters are owned and tested, without creating bureaucracy?`,
  a: r`### Decision rules (published, short)
A dependency becomes a port if it is: external or infrastructure; non-deterministic (time, randomness, ids); needs substitution for tests or environments; or likely to change vendor/technology. Pure domain collaborators stay concrete. Every port is a long-term commitment.

### Port design standard
- Named in domain language; neutral types; async with cancellation for I/O.
- **Documented semantics**: idempotency, ordering, consistency, outcome categories (rejected/unavailable/unknown), timeouts.
- **Contract test suite** shipped with the port.
- Batch methods where callers work on sets.

### Adapter ownership
- The team that owns the external relationship owns its adapters (a shared "Payments Providers" team may provide adapters as packages to several services).
- Each adapter has: contract tests, a fake or simulator, resilience configuration, dashboards, and a runbook.

### Lightweight governance
- A **port catalogue** in the developer portal (port, owners, adapters, consumers, semantics).
- Design review checklist item for new ports (not a committee).
- Fitness functions: no technology types in core assemblies; every port has a contract suite; fakes not referenced by production hosts.

### Avoid
Interfaces for everything, central approval for each interface, and ports without owners.`,
  code: r`~~~csharp
// Port declaration carries its semantics in a machine-readable form for the catalogue
[Port(Owner = "team-payments-providers", Semantics = PortSemantics.IdempotentByKey | PortSemantics.OutcomeUnknownPossible,
      ContractSuite = typeof(PaymentGatewayContract))]
public interface IPaymentGateway
{
    Task<Result<AuthAck, GatewayError>> AuthoriseAsync(AuthRequest r, string idempotencyKey, CancellationToken ct);
}

// Fitness function: every port has a contract suite and at least one fake in test assemblies
[Fact]
public void Every_port_has_contract_suite_and_fake()
{
    var ports = PortCatalogue.Scan(typeof(IPaymentGateway).Assembly);
    var missing = ports.Where(p => p.ContractSuite is null || !TestAssemblies.HaveFakeFor(p.Type)).Select(p => p.Type.Name);
    Assert.Empty(missing);
}

// Fitness function: production hosts never reference fake/simulator assemblies
[Fact]
public void Production_host_has_no_test_adapters() =>
    Assert.DoesNotContain(typeof(Program).Assembly.GetReferencedAssemblies(), a => a.Name!.EndsWith(".Fakes") || a.Name!.EndsWith(".Simulators"));
~~~`,
  pts: [r`Short published rules for what becomes a port.`, r`Port standard: domain language, documented semantics, contract suite.`, r`Adapter ownership follows ownership of the external relationship.`, r`Port catalogue, review checklist and fitness functions instead of committees.`, r`No interfaces-for-everything, no ownerless ports.`],
  ex: r`A platform discovered 14 different payment-provider adapters across services, each with different retry and idempotency behaviour. A shared providers team publishing ports with contract suites consolidated them to 4 adapters and removed a class of duplicate-charge incidents.`,
  fu: [r`Who owns a port used by many services?`, r`How do you deprecate a port?`, r`How do you share adapters as packages safely?`],
  pit: [r`Ports without documented semantics.`, r`Committees approving interfaces.`, r`Duplicate adapters per service.`] },

{ id: 'q39', level: 'Principal', tags: ['hexagonal', 'over-engineering', 'review', 'simplification'],
  q: r`You review a codebase with 140 interfaces, most with one implementation, a "port" for every class, mocks everywhere, and slow delivery. Assess it and lead a simplification without losing the real benefits of ports.`,
  a: r`### Assess
- Classify interfaces: **real ports** (external/infrastructure/non-deterministic/substituted) vs **internal abstractions** with one implementation and no substitution need.
- Look at tests: mocks verifying calls between internal classes (brittle) vs fakes at real boundaries.
- Measure: files touched per change, test breakage on refactors, onboarding time, lead time.

### Simplify
1. **Inline internal interfaces** with a single implementation and no test seam need: use concrete classes (sealed); domain services stay concrete.
2. Keep and strengthen **real ports**: add contract suites and fakes where mocks were used.
3. Replace interaction-based mocks of internal classes with **state-based tests** at the inbound port level.
4. Collapse adapter projects that wrap nothing.
5. Document the rules for future ports (decision criteria) and add a lightweight review check.

### Expected result
Fewer files per change, fewer brittle tests, same or better confidence because tests now exercise real behaviour through ports with fakes at true boundaries.

### Communicate
Frame it as returning to the purpose of ports (isolating volatile dependencies), not abandoning the architecture.`,
  code: r`~~~csharp
// Before: interface + mock for a pure calculation
public interface IFeeCalculator { Money Calculate(Payment p, FeeSchedule s); }
public sealed class FeeCalculator : IFeeCalculator { public Money Calculate(Payment p, FeeSchedule s) => s.Apply(p.Amount); }
// test: mock.Setup(f => f.Calculate(...)).Returns(...); mock.Verify(f => f.Calculate(...), Times.Once);

// After: concrete domain service used directly; tests use real calculations
public static class Fees { public static Money For(Payment p, FeeSchedule s) => s.Apply(p.Amount); }

// Real port kept, mocks replaced by a fake with a contract suite
public interface IPaymentGateway { Task<Result<AuthAck, GatewayError>> AuthoriseAsync(AuthRequest r, string key, CancellationToken ct); }
public sealed class FakePaymentGateway : IPaymentGateway { /* state-based, configurable outcomes */
    public Task<Result<AuthAck, GatewayError>> AuthoriseAsync(AuthRequest r, string key, CancellationToken ct) => throw new NotImplementedException(); }

// Inventory script used in the review: interfaces with exactly one implementation and no test doubles
// dotnet run --project tools/InterfaceAudit -- --solution Payments.sln --report interfaces.csv
~~~`,
  pts: [r`Separate real ports from single-implementation internal interfaces.`, r`Inline internal abstractions; keep and strengthen real ports.`, r`Replace interaction mocks with state-based tests through inbound ports.`, r`Measure files per change, test brittleness and lead time.`, r`Frame simplification as restoring the purpose of ports.`],
  ex: r`A team removed 96 of 140 interfaces and replaced 2,300 mock-based tests with 600 port-level scenario tests; refactors stopped breaking hundreds of tests, average PR size halved, and the 44 remaining true ports all gained contract suites.`,
  fu: [r`How do you convince the original authors?`, r`What signals justify an internal interface?`, r`How do you prevent re-growth of unnecessary abstractions?`],
  pit: [r`Ports for every class.`, r`Mocks of internal collaborators.`, r`Removing real ports along with the noise.`] },

{ id: 'q40', level: 'Principal', tags: ['hexagonal', 'payments', 'multi-provider', 'strategy'],
  q: r`The business wants a multi-PSP strategy (route payments across 3 providers for cost, approval rates and resilience). Lay out the architecture, the lowest-common-denominator trap, and how you justify the investment.`,
  a: r`### Architecture
- **Core**: payment lifecycle, routing policy (cost, approval rates by BIN/issuer/region, provider health, merchant contracts), provider affinity per payment.
- **Ports**: capability-based ({{IAuthorisation}}, {{ICapture}}, {{IRefund}}, {{ITokenisation}}, {{IDisputes}}), with explicit outcome categories.
- **Adapters per provider**, owned by one team, with contract suites and simulators.
- **Network tokens / vault** independent of providers (tokens portable across providers), otherwise routing is limited by where cards were tokenised.
- **Reconciliation and settlement** per provider into a common ledger.

### Lowest-common-denominator trap
Ports that only include features all providers share hide valuable provider-specific capabilities (3DS flows, network token lifecycle, account updater, installments). Handle by:
- **Capability flags** per adapter; the routing policy considers capabilities.
- **Optional ports** implemented by some adapters only.
- Accepting some provider-specific flows behind feature-specific ports.

### Justifying the investment
- Cost savings (basis points × volume), approval-rate uplift (often the largest lever), resilience (provider outages become partial degradations), negotiation leverage.
- Costs: integration and certification per provider, operations, reconciliation complexity, PCI scope for a vault.
Present as a business case with measured pilot results on a segment.`,
  dia: r`flowchart LR
  CORE[Payment core: lifecycle + routing policy] --> AUTH((IAuthorisation))
  CORE --> REF((IRefund))
  CORE --> TOK((ITokenisation))
  AUTH -.-> A1[Provider A adapter]
  AUTH -.-> A2[Provider B adapter]
  AUTH -.-> A3[Provider C adapter]
  TOK -.-> V[Independent vault and network tokens]
  A1 --> REC[Per-provider reconciliation]
  A2 --> REC
  A3 --> REC
  REC --> LED[Common ledger]`,
  code: r`~~~csharp
public sealed record ProviderCapabilities(bool ThreeDs2, bool NetworkTokens, bool Installments, IReadOnlySet<string> Currencies);

public sealed class RoutingPolicy(IProviderStats stats, IProviderContracts contracts, IProviderHealth health)
{
    public ProviderId Choose(PaymentContext p)
    {
        var candidates = contracts.For(p.Merchant)
            .Where(c => c.Capabilities.Currencies.Contains(p.Amount.Currency))
            .Where(c => !p.Requires3ds || c.Capabilities.ThreeDs2)
            .Where(c => health.IsHealthy(c.Provider));
        return candidates
            .OrderByDescending(c => stats.ApprovalRate(c.Provider, p.Bin, p.IssuerCountry))   // approval rate first
            .ThenBy(c => c.CostBps(p.Amount))
            .First().Provider;
    }
}

// Optional capability port implemented only by some adapters
public interface IInstallments { Task<InstallmentPlan> OfferAsync(PaymentContext p, CancellationToken ct); }
~~~`,
  pts: [r`Core owns routing policy and provider affinity; capability ports with outcome categories.`, r`Provider-independent tokens enable real routing.`, r`Avoid lowest-common-denominator ports: capability flags and optional ports.`, r`Per-provider reconciliation into a common ledger.`, r`Business case: approval uplift, cost, resilience vs integration and operations cost.`],
  ex: r`A marketplace added a second and third PSP behind capability ports with an independent vault; approval rates rose by 1.8 points through BIN-based routing (worth far more than the fee savings), and a 3-hour outage at one PSP reduced volume by only 12%.`,
  fu: [r`How do you measure approval-rate uplift fairly?`, r`What happens to refunds when routing changes?`, r`How do you handle provider-specific 3DS flows?`],
  pit: [r`Tokens locked to one provider.`, r`Lowest-common-denominator ports.`, r`Routing rules hidden in adapters.`] },

{ id: 'q41', level: 'Principal', tags: ['hexagonal', 'cloud-portability', 'vendor-lock-in', 'trade-offs'],
  q: r`Leadership asks for cloud portability: "wrap every AWS/Azure service behind ports so we can move clouds". Respond with a principled position on which cloud services to abstract and which to embrace.`,
  a: r`### What portability really costs
Abstracting every managed service produces lowest-common-denominator ports that forgo the features you pay the cloud for (DynamoDB conditional writes and streams, Service Bus sessions, S3 event notifications), adds adapters and tests, and still leaves infrastructure-as-code, IAM, networking, observability and data migration cloud-specific. Most of a cloud move is not code.

### Principled position
- **Abstract at the business capability level**, where the core needs it anyway: {{IDocumentStore}}, {{IEventPublisher}}, {{ISecretProvider}}, {{IObjectStorage}} as **domain-meaningful ports**. These ports exist for testability and clarity; portability is a side benefit.
- **Embrace** managed services inside adapters; use their native features fully.
- Do **not** abstract the platform plumbing (IAM, VPCs, load balancers): that is IaC, not application ports.
- **Data gravity**: choose portable data formats and export capability for critical data rather than abstracting databases' query models.
- Identify **exit-relevant** dependencies (proprietary serverless workflows, vendor-specific ML) and document exit plans and costs per dependency (regulators such as the EBA/PRA expect exit strategies for critical outsourcing).

### Communicate
"We will make an exit **possible and estimated**, not free; we will not cripple our use of the cloud for a hypothetical move."`,
  code: r`~~~csharp
// Capability port exists for the core's needs; adapter uses native features fully
public interface IStatementArchive
{
    Task StoreAsync(StatementId id, Stream pdf, RetentionPolicy retention, CancellationToken ct);
    Task<Uri> GetDownloadLinkAsync(StatementId id, TimeSpan validity, CancellationToken ct);
}

// Azure adapter: immutable storage policy + SAS links (native features, not abstracted away)
internal sealed class BlobStatementArchive(BlobContainerClient container) : IStatementArchive
{
    public async Task StoreAsync(StatementId id, Stream pdf, RetentionPolicy r, CancellationToken ct)
    {
        var blob = container.GetBlobClient($"{id}.pdf");
        await blob.UploadAsync(pdf, new BlobUploadOptions { ImmutabilityPolicy = new() { ExpiresOn = DateTimeOffset.UtcNow.Add(r.Duration), PolicyMode = BlobImmutabilityPolicyMode.Locked } }, ct);
    }
    public Task<Uri> GetDownloadLinkAsync(StatementId id, TimeSpan v, CancellationToken ct) =>
        Task.FromResult(container.GetBlobClient($"{id}.pdf").GenerateSasUri(BlobSasPermissions.Read, DateTimeOffset.UtcNow.Add(v)));
}
// AWS equivalent would use S3 Object Lock + presigned URLs: different adapter, same port.
~~~`,
  pts: [r`Abstract at business capability level, where the core needs ports anyway.`, r`Use managed services' native features inside adapters.`, r`Do not abstract platform plumbing; that is IaC.`, r`Plan data export and exit strategies per critical dependency.`, r`Make exit possible and estimated, not free.`],
  ex: r`A firm built a generic queue abstraction over SQS and Service Bus that exposed neither sessions nor FIFO; ordering bugs followed. Replacing it with capability ports whose adapters used native ordering features fixed the bugs, and the documented exit plan satisfied the regulator's outsourcing review.`,
  fu: [r`Which dependencies are hardest to exit and why?`, r`How do you estimate the cost of a cloud exit?`, r`What do regulators expect in an exit plan?`],
  pit: [r`Abstracting everything for portability.`, r`Lowest-common-denominator cloud ports.`, r`Ignoring data and IaC in portability claims.`] },

{ id: 'q42', level: 'Principal', tags: ['hexagonal', 'llm', 'ai', 'evaluation'],
  q: r`Integrate an LLM into a business workflow (summarising disputes, extracting fields from documents) using ports and adapters. How do you design the port, swap models/providers, evaluate quality, and keep the core deterministic and auditable?`,
  a: r`### Port design
A **capability port** in business terms: {{IDisputeSummariser.SummariseAsync(dispute)}}, {{IInvoiceExtractor.ExtractAsync(document)}} returning **structured, validated** outputs (schema-checked JSON mapped to domain types), plus confidence and model/version metadata. Not {{IChatCompletion}} in the core.

### Adapters
- Provider adapters (Azure OpenAI, Anthropic, local models) handle prompts, structured output modes, retries, rate limits and cost tracking.
- **Fake adapters** returning fixed outputs for core tests (determinism).
- **Recorded adapters** replaying stored model outputs for regression.

### Keeping the core sound
- The core treats AI outputs as **untrusted suggestions**: validates them (schema, business rules), routes low-confidence results to humans, never lets them directly move money or change limits without checks.
- Records model id, prompt version, inputs hash and output for **audit and reproducibility** (LLMs are not deterministic; recording is how you reproduce).

### Evaluation
- An **evaluation harness** (driving adapter) runs a labelled dataset through the port with each candidate adapter/prompt version, computing accuracy, field-level precision/recall, latency and cost.
- Gate prompt/model changes on evaluation results, like contract tests.

### Data protection
PII redaction in the adapter, data residency per provider, no training on your data contract terms.`,
  code: r`~~~csharp
public sealed record ExtractedInvoice(string SupplierName, string InvoiceNumber, DateOnly IssueDate, Money Total, decimal Confidence);
public sealed record AiProvenance(string Provider, string Model, string PromptVersion, string InputHash);

public interface IInvoiceExtractor
{
    Task<(ExtractedInvoice? Result, AiProvenance Provenance)> ExtractAsync(DocumentRef doc, CancellationToken ct);
}

// Core: validates and routes; AI output is a suggestion
public async Task<Result> Handle(ProcessInvoice cmd, CancellationToken ct)
{
    var (extracted, provenance) = await extractor.ExtractAsync(cmd.Document, ct);
    audit.Record(AuditEntry.AiExtraction(cmd.Document, provenance));
    if (extracted is null || extracted.Confidence < 0.85m || !InvoiceRules.IsPlausible(extracted))
        return await reviewQueue.EnqueueAsync(cmd.Document, extracted, ct);          // human in the loop
    var invoice = Invoice.FromExtraction(extracted, provenance);
    invoices.Add(invoice);
    await uow.CommitAsync(ct);
    return Result.Ok();
}

// Evaluation harness: gate prompt/model changes
[Fact, Trait("Category", "Evaluation")]
public async Task Extraction_accuracy_meets_threshold()
{
    var report = await Evaluate.RunAsync(new AzureOpenAiInvoiceExtractor(TestConfig.Candidate), LabelledSets.Invoices2026Q3);
    Assert.True(report.FieldAccuracy("Total") >= 0.98, report.ToString());
    Assert.True(report.CostPerDocumentUsd <= 0.004m, report.ToString());
}
~~~`,
  pts: [r`Capability ports with structured, validated outputs and provenance.`, r`Provider, fake and recorded adapters.`, r`AI outputs are untrusted suggestions; validate and route low confidence to humans.`, r`Record model, prompt version and inputs for audit and reproduction.`, r`Evaluation harness gates prompt and model changes.`],
  ex: r`An accounts-payable team let an LLM write extracted totals straight into payment runs; a prompt change caused currency confusion on 2% of invoices. Re-architecting behind a validated port with confidence routing and an evaluation gate caught the next regression before release.`,
  fu: [r`How do you test a non-deterministic adapter?`, r`How do you switch providers without regressions?`, r`What belongs in AI provenance records?`],
  pit: [r`Chat-completion APIs in the core.`, r`Unvalidated AI output moving money.`, r`No evaluation before model changes.`] },

{ id: 'q43', level: 'Principal', tags: ['hexagonal', 'legacy', 'strangler', 'integrations'],
  q: r`A 12-year-old monolith calls 25 external systems directly from controllers, stored procedures and batch jobs. Plan how to put those integrations behind ports and adapters incrementally, and what you gain at each step.`,
  a: r`### Step 0: inventory
For each external system: who calls it (code paths, SQL linked servers, batch scripts), protocol, criticality, incidents, test availability. Rank by risk and change frequency.

### Step 1: seams without behaviour change
For the top integrations, introduce a port in the monolith's language and move the existing calling code into an adapter (same behaviour). Gain: one place per integration, visibility of all callers.

### Step 2: contract tests and fakes
Add contract suites and fakes/recordings. Gain: tests for business code no longer need the external system.

### Step 3: resilience and observability
Timeouts, circuit breakers, metrics and traces per adapter. Gain: outages become visible and contained.

### Step 4: move logic out of the wrong places
Business rules found in adapters or stored procedures move into the core; SQL linked-server calls become adapters. Gain: rules testable and owned.

### Step 5: enable change
New providers, protocol upgrades and service extractions now happen behind ports (branch by abstraction), one integration at a time.

### Program management
Track per integration: port in place, contract tests, resilience, dashboards. Prioritise by incident history and upcoming vendor changes (deprecations are natural deadlines).`,
  code: r`~~~text
Integration inventory (excerpt)

System            Callers                               Protocol     Incidents/yr  Next vendor change   Priority
Card processor    3 controllers, 2 batch jobs, 1 proc   ISO 8583     7             v2 deprecation 2027  1
KYC vendor        onboarding controller, nightly job    REST         4             -                    2
Core banking      14 stored procs (linked server)       SQL/ODBC     9             upgrade 2027         1
SMS gateway       6 places                              REST         1             -                    4
~~~
~~~csharp
// Step 1: seam with no behaviour change: existing code moved behind a port
public interface ICardProcessor { Task<AuthorisationOutcome> AuthoriseAsync(AuthorisationRequest r, CancellationToken ct); }
internal sealed class LegacyCardProcessorAdapter(LegacyIso8583Client client) : ICardProcessor
{
    public Task<AuthorisationOutcome> AuthoriseAsync(AuthorisationRequest r, CancellationToken ct) =>
        Task.FromResult(LegacyMapping.ToOutcome(client.Authorise(LegacyMapping.ToLegacy(r))));   // same calls as before, now in one place
}
// Architecture test added in step 1: no other code may reference LegacyIso8583Client
~~~`,
  pts: [r`Inventory callers, protocols, incidents and vendor deadlines.`, r`Introduce seams without behaviour change first.`, r`Then contract tests, fakes, resilience and observability.`, r`Move misplaced business logic into the core.`, r`Enable provider and protocol changes via branch by abstraction.`],
  ex: r`A retail bank found its card processor called from 11 places, including two stored procedures over a linked server. Consolidating behind one port before a mandated protocol upgrade turned the upgrade into a single adapter change; the previous upgrade had taken a year.`,
  fu: [r`How do you handle stored procedures that call external systems?`, r`How do you prioritise 25 integrations?`, r`How do you prevent new direct calls?`],
  pit: [r`Rewriting behaviour while introducing seams.`, r`Leaving hidden callers (batch, SQL).`, r`No enforcement after consolidation.`] },

{ id: 'q44', level: 'Principal', tags: ['hexagonal', 'simulation-platform', 'test-environments', 'program'],
  q: r`Your organisation's test environments are unreliable because every external dependency (schemes, banks, KYC, exchanges) is shared, flaky or unavailable. Propose a platform-wide simulation strategy ("digital twin of the outside world") and its operating model.`,
  a: r`### Vision
Every external dependency has an **owned simulator** speaking its real protocol, deployable on demand, scriptable per test, with realistic behaviour and failure modes. Real vendor test environments are used for certification and nightly contract runs, not for daily development.

### Components
- **Simulator per external system** (card schemes, payment providers, banks via ISO 20022, KYC, exchanges, market data), owned by the team that owns the corresponding adapter.
- A **control plane** API per simulator (scenarios, latency, failures, inspection), plus a shared scenario library.
- **Ephemeral environments**: a service plus its simulators spun up per PR or per test run (containers, Kubernetes namespaces).
- **Data generation**: synthetic but realistic customers, cards, accounts.
- **Fidelity assurance**: contract suites run against simulator and vendor sandbox; replayed production traffic compared periodically.

### Operating model
- Platform team provides the framework, hosting and scenario tooling; domain teams own their simulators.
- Fidelity SLAs: simulator updated within N days of a vendor change.
- Metrics: environment availability, test flakiness, lead time, defects found pre-production vs post.

### Business case
Days of blocked testing per month × engineers, incidents traced to untestable scenarios, vendor test environment fees; set against platform and simulator maintenance cost.`,
  dia: r`flowchart LR
  subgraph EphemeralEnv[Ephemeral test environment per PR]
    SVC[Service under test] --> S1[Card scheme simulator]
    SVC --> S2[Bank ISO 20022 simulator]
    SVC --> S3[KYC simulator]
  end
  TESTS[Scenario tests] --> SVC
  TESTS --> CP[Simulator control planes]
  CP --> S1
  CP --> S2
  CP --> S3
  NIGHT[Nightly contract runs] --> VS[Vendor sandboxes]
  NIGHT --> S1`,
  code: r`~~~yaml
# Ephemeral environment definition (per PR)
services:
  payments-api:
    image: payments-api:pr-1234   # tag injected by the pipeline
    environment:
      Scheme__Adapter: Iso8583
      Scheme__Host: scheme-sim
      Kyc__BaseUrl: http://kyc-sim
  scheme-sim:
    image: sims/card-scheme:4.2      # ISO 8583, control plane on :8081
  kyc-sim:
    image: sims/kyc-vendor:2.7
~~~
~~~csharp
// Scenario from the shared library: issuer timeout then late approval
await schemeSim.ArrangeAsync(Scenarios.IssuerTimeoutThenLateApproval(pan: TestCards.Visa1, delayMs: 35_000));
var auth = await api.AuthoriseAsync(TestCards.Visa1, Money.Gbp(25));
Assert.Equal("pending", auth.Status);                    // timeout handled as unknown outcome
await Eventually(() => api.GetPaymentAsync(auth.Id), p => p.Status == "authorised");   // reconciled after late response
~~~`,
  pts: [r`Owned simulators per external system with control planes.`, r`Ephemeral environments per PR with simulators.`, r`Vendor sandboxes for certification and nightly contracts only.`, r`Fidelity assured by contract suites and replay comparisons.`, r`Platform team provides tooling; domain teams own simulators; measured business case.`],
  ex: r`A payments company lost an estimated 300 engineer-days per quarter waiting for shared scheme and bank test environments. A simulator platform with ephemeral environments cut that to near zero and found 40% more defects before production, mostly in timeout and late-response handling.`,
  fu: [r`How do you fund simulator maintenance?`, r`What fidelity is enough?`, r`How do you keep synthetic data realistic?`],
  pit: [r`Simulators nobody owns.`, r`Happy-path-only simulators.`, r`Abandoning vendor sandboxes entirely.`] },

{ id: 'q45', level: 'Principal', tags: ['hexagonal', 'degraded-mode', 'disaster-recovery', 'stand-in'],
  q: r`A critical dependency (the card issuer host or core banking) can be down for hours. Design degraded modes and stand-in processing through ports and adapters, including the business rules, risk limits and catch-up afterwards.`,
  a: r`### Degraded modes are business decisions
Examples: authorise card payments up to a limit when the issuer host is down (**stand-in processing**), queue payments for later submission, serve balances from a cached snapshot marked as such, disable specific features.

### Architecture
- The driven port exposes **Unavailable** explicitly.
- A **stand-in adapter** or a core **policy** applies stand-in rules: per-card and per-merchant-category limits, velocity checks using locally available data, a cached balance snapshot with age.
- Decisions taken in stand-in are **recorded** (stand-in flag, rule version, limits used).
- A **circuit breaker** determines when the primary is down; a manual override exists for operations.

### Catch-up
When the primary returns, a **store-and-forward** process submits stand-in decisions (advices) in order, idempotently; mismatches (insufficient funds now) are handled by business processes (collections, reversals).

### Risk control
Stand-in limits sized by risk appetite; monitoring of stand-in exposure in real time; automatic tightening as exposure grows.

### Testing
Simulated outages via simulators and fault injection; game days with operations.`,
  code: r`~~~csharp
public sealed class AuthorisationService(IIssuerHost issuer, IStandInPolicy standIn, IStandInLedger standInLedger, TimeProvider clock)
{
    public async Task<AuthDecision> AuthoriseAsync(AuthRequest r, CancellationToken ct)
    {
        var outcome = await issuer.AuthoriseAsync(r, ct);
        if (outcome is not IssuerOutcome.Unavailable) return AuthDecision.FromIssuer(outcome);

        var decision = standIn.Decide(r, standInLedger.ExposureFor(r.CardToken), clock.GetUtcNow());   // business rules
        await standInLedger.RecordAsync(r, decision, ct);                                              // for store-and-forward
        return decision;
    }
}

public sealed class StandInPolicy(StandInLimits limits) : IStandInPolicy
{
    public AuthDecision Decide(AuthRequest r, StandInExposure exposure, DateTimeOffset now) =>
        r.Amount > limits.PerTransaction(r.MerchantCategory) ? AuthDecision.Decline("standin.amount")
        : exposure.Today.Add(r.Amount) > limits.PerCardPerDay ? AuthDecision.Decline("standin.daily")
        : exposure.CountLastHour >= limits.VelocityPerHour ? AuthDecision.Decline("standin.velocity")
        : AuthDecision.ApproveStandIn(limits.Version);
}

// Store-and-forward when the issuer returns
public sealed class StandInForwarder(IStandInLedger ledger, IIssuerHost issuer) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        await foreach (var advice in ledger.PendingInOrderAsync(stop))
        {
            var res = await issuer.SendAdviceAsync(advice, idempotencyKey: advice.Id.ToString(), stop);
            await ledger.MarkForwardedAsync(advice.Id, res, stop);
        }
    }
}
~~~`,
  pts: [r`Degraded modes are business decisions with explicit rules.`, r`Ports expose Unavailable; policies apply stand-in limits.`, r`Record every stand-in decision; store-and-forward afterwards.`, r`Monitor and cap stand-in exposure in real time.`, r`Test outages with simulators and game days.`],
  ex: r`An issuer processor's host outage lasted four hours on a Saturday; with stand-in limits by merchant category, 92% of transactions were approved, total exposure stayed within the risk appetite, and store-and-forward reconciled all advices within 40 minutes of recovery.`,
  fu: [r`How do you size stand-in limits?`, r`What if stand-in approvals exceed real balances?`, r`How do you switch modes manually?`],
  pit: [r`Hard failure with no degraded mode.`, r`Unrecorded stand-in decisions.`, r`Unlimited stand-in exposure.`] },

{ id: 'q46', level: 'Principal', tags: ['hexagonal', 'code-review'],
  q: r`Code review: what is wrong with these "ports and adapters" and how would you fix them?`,
  a: r`~~~csharp
// Core
public interface IHttpPaymentPort { Task<HttpResponseMessage> PostAsync(string path, object body); }
public interface IDbPort { Task<int> ExecuteAsync(string sql, object args); }

public class PaymentService(IHttpPaymentPort http, IDbPort db)
{
    public void Pay(Guid orderId, decimal amount)
    {
        var resp = http.PostAsync("/v2/charges", new { amount = (int)(amount * 100), currency = "gbp" }).Result;
        if ((int)resp.StatusCode == 402) { db.ExecuteAsync("UPDATE Orders SET Status='DECLINED' WHERE Id=@id", new { id = orderId }); return; }
        if (!resp.IsSuccessStatusCode) throw new Exception("payment failed");
        db.ExecuteAsync("UPDATE Orders SET Status='PAID' WHERE Id=@id", new { id = orderId });
    }
}

// Adapter
public class StripeAdapter : IHttpPaymentPort
{
    public async Task<HttpResponseMessage> PostAsync(string path, object body)
    {
        if (DateTime.Now.Hour < 6) return new HttpResponseMessage(HttpStatusCode.OK);   // skip charges at night (maintenance)
        return await new HttpClient { BaseAddress = new Uri("https://api.stripe.com") }.PostAsJsonAsync(path, body);
    }
}
~~~

Findings:
1. **Technology-shaped ports**: {{IHttpPaymentPort}} and {{IDbPort}} leak HTTP and SQL into the core; the core knows Stripe's path, units and status codes.
2. **Business rule in the adapter** (skip charges before 6am) and it fakes success: silent free goods.
3. **Sync-over-async** ({{.Result}}) and **un-awaited** {{ExecuteAsync}} calls: updates may not happen; exceptions lost.
4. **No idempotency key**: retries double-charge; **no outcome-unknown handling** for timeouts.
5. Money as decimal cast to int (rounding, no currency type); hard-coded currency.
6. {{new HttpClient}} per call (socket exhaustion); no timeouts or resilience; no cancellation.
7. Generic {{Exception}}; no domain outcome; order status updated with raw SQL instead of the domain model.
8. {{DateTime.Now}} local time.`,
  code: r`~~~csharp
// Core ports in domain terms
public interface IPaymentGateway
{
    Task<Result<ChargeAck, GatewayError>> ChargeAsync(OrderId order, Money amount, string idempotencyKey, CancellationToken ct);
}
public interface IOrderStore { Task<Order?> GetAsync(OrderId id, CancellationToken ct); Task SaveAsync(Order o, CancellationToken ct); }

public sealed class PayOrder(IPaymentGateway gateway, IOrderStore orders) : IPayOrder
{
    public async Task<Result> ExecuteAsync(PayOrderCommand cmd, CancellationToken ct)
    {
        var order = await orders.GetAsync(cmd.OrderId, ct) ?? throw new OrderNotFoundException(cmd.OrderId);
        var result = await gateway.ChargeAsync(order.Id, order.Total, idempotencyKey: $"order-{order.Id}", ct);
        result.Switch(
            ack => order.MarkPaid(ack.Reference),
            err => err switch
            {
                GatewayError.Rejected r => order.MarkDeclined(r.Reason),
                GatewayError.OutcomeUnknown => order.MarkPaymentPending(),          // reconciled later
                _ => order.MarkPaymentRetryable()
            });
        await orders.SaveAsync(order, ct);
        return Result.Ok();
    }
}

// Adapter: typed HttpClient with resilience; translates Stripe semantics; no business rules
internal sealed class StripeGateway(HttpClient http) : IPaymentGateway { /* minor units, currency codes, 402 -> Rejected, timeouts -> OutcomeUnknown */
    public Task<Result<ChargeAck, GatewayError>> ChargeAsync(OrderId o, Money a, string key, CancellationToken ct) => throw new NotImplementedException(); }
~~~`,
  pts: [r`Technology-shaped ports leak HTTP and SQL into the core.`, r`Business rules (and fake success) inside adapters.`, r`Sync-over-async, un-awaited calls, no cancellation.`, r`No idempotency or unknown-outcome handling.`, r`Money handling, HttpClient misuse, raw SQL instead of the domain.`],
  ex: r`This pattern shipped in an e-commerce checkout: the "maintenance window" shortcut in the adapter gave away a night of orders after a server time-zone change moved the window into peak hours. The redesign removed rules from adapters and added reconciliation.`,
  fu: [r`Where should a maintenance-window rule live, if anywhere?`, r`How do you test the unknown-outcome path?`, r`What would the contract suite for IPaymentGateway include?`],
  pit: [r`Fixing only the HttpClient usage.`, r`Keeping technology-shaped ports.`, r`Ignoring the fake-success branch.`] },

{ id: 'q47', level: 'Principal', tags: ['hexagonal', 'clean', 'onion', 'org-standards'],
  q: r`Your organisation has teams using Clean, Hexagonal and Onion terminology inconsistently. Do you standardise on one vocabulary? How do you explain the relationship and teach it so designs become comparable across teams?`,
  a: r`### The relationship
All three share one rule: **dependencies point toward the business core**; infrastructure plugs in through abstractions the core owns.
- **Hexagonal** names the **edges**: ports (inbound/outbound) and adapters (driving/driven). Says little about the inside.
- **Onion** names **layers inside**: domain model, domain services, application services, infrastructure outside.
- **Clean** combines both with **use cases** as first-class and the Dependency Rule stated explicitly.

### Standardise vocabulary, not dogma
Pick a **house vocabulary** that combines the useful parts, for example:
- "Core" = domain + application (use cases).
- "Inbound port" = use case interface; "outbound port" = dependency interface.
- "Driving adapter" / "driven adapter".
- "Composition root".
Publish a one-page glossary with a reference diagram and a reference repository.

### Teaching
- A worked example in the house template (one use case traced through every element).
- Design review templates that ask about ports and adapters explicitly (which outbound ports, their semantics, contract tests).
- Short internal course built on real incidents (leaky ports, logic in adapters).

### Why it matters
Comparable designs, faster reviews, transferable engineers between teams, consistent tooling (architecture tests, templates).`,
  code: r`~~~text
House architecture glossary (excerpt)

Core              Domain model + use cases. No infrastructure references.
Inbound port      Interface (or core class) a driving adapter calls: IPlaceOrder, ICapturePayment.
Outbound port     Interface the core needs: IOrderStore, IPaymentGateway. Owned by the core, domain-shaped,
                  documented semantics, contract test suite required.
Driving adapter   HTTP endpoint, gRPC service, consumer, scheduler, CLI, test harness.
Driven adapter    SQL store, provider client, broker publisher, simulator, fake.
Composition root  Host project wiring adapters to ports per environment; startup guardrails.

Mapping: Clean "use case" = inbound port + its implementation; Clean "interface adapters" = adapters;
         Onion "infrastructure" = driven adapters.
~~~
~~~csharp
// Reference repository: one use case traced through every element, used in onboarding
// Api/Orders/PlaceOrderEndpoint.cs -> Core/Ports/Inbound/IPlaceOrder.cs -> Core/PlaceOrderService.cs
//   -> Core/Ports/Outbound/IExchangeGateway.cs -> Adapters/Fix/FixExchangeGateway.cs (+ contract tests, simulator)
~~~`,
  pts: [r`Clean, Hexagonal and Onion share the inward dependency rule.`, r`Hexagonal names edges; Onion names inner layers; Clean adds use cases.`, r`Standardise a house vocabulary and glossary, not dogma.`, r`Teach with a reference repository and review templates.`, r`Comparable designs make reviews and team moves easier.`],
  ex: r`At a fintech, "service", "port", "provider" and "gateway" meant different things per team; design reviews spent most of their time on terminology. A one-page glossary and a reference repository cut review time noticeably and made architecture tests reusable across teams.`,
  fu: [r`Would you rename existing code to match the vocabulary?`, r`How do you handle teams that prefer vertical slices?`, r`What goes in the reference repository?`],
  pit: [r`Religious debates over names.`, r`Glossaries without examples.`, r`Forcing one structure on every service.`] },

{ id: 'q48', level: 'Principal', tags: ['hexagonal', 'sdk-design', 'plugins', 'extensibility'],
  q: r`You are building an internal SDK (a payments client library used by 40 services) or a plug-in platform. How do ports and adapters shape the SDK's design so consumers can test, extend and swap implementations without forking it?`,
  a: r`### SDK as a core with ports
- The SDK's **public API** is its inbound port (a small, stable surface: {{IPaymentsClient}}).
- Its **dependencies** are outbound ports consumers can replace: transport ({{HttpMessageHandler}}), clock, logging, token acquisition, retry policy.
- Ships **test doubles**: an in-memory fake implementing {{IPaymentsClient}} with scenario controls, so consumer services test without the network.

### Extensibility without forking
- Extension points as interfaces with sensible defaults (custom token providers, custom serializers).
- Decorators supported by DI registration ({{AddPaymentsClient(...).AddHttpMessageHandler<...>()}}).
- Avoid exposing internal types; version the public API with semantic versioning; analyzers for breaking changes (PublicApiAnalyzers).

### Plug-in platforms
For host applications that load third-party plug-ins: define ports the host calls (plug-in contracts) and ports plug-ins call (host services); load with {{AssemblyLoadContext}} isolation; version contracts; validate plug-ins with a contract test kit published with the SDK.

### Governance
Changelog and deprecation policy; compatibility tests across supported versions; telemetry on API usage to know what can be removed.`,
  code: r`~~~csharp
// Public inbound port of the SDK
public interface IPaymentsClient
{
    Task<PaymentResult> CreatePaymentAsync(CreatePayment request, CancellationToken ct = default);
    Task<Payment?> GetPaymentAsync(string paymentId, CancellationToken ct = default);
}

// Registration with replaceable outbound dependencies
public static class PaymentsClientRegistration
{
    public static IHttpClientBuilder AddPaymentsClient(this IServiceCollection s, Action<PaymentsClientOptions> configure)
    {
        s.Configure(configure);
        s.TryAddSingleton<ITokenProvider, ClientCredentialsTokenProvider>();     // consumers can register their own first
        s.TryAddSingleton(TimeProvider.System);
        var builder = s.AddHttpClient<IPaymentsClient, PaymentsClient>();
        builder.AddStandardResilienceHandler();                                   // consumers can add their own handlers too
        return builder;
    }
}

// Shipped test double for consumers (separate package: Company.Payments.Client.Testing)
public sealed class FakePaymentsClient : IPaymentsClient
{
    private readonly Dictionary<string, Payment> _payments = new();
    public Func<CreatePayment, PaymentResult>? Scenario { get; set; }
    public Task<PaymentResult> CreatePaymentAsync(CreatePayment r, CancellationToken ct = default)
    {
        var result = Scenario?.Invoke(r) ?? PaymentResult.Succeeded($"pay_{_payments.Count + 1}");
        if (result.Succeeded) _payments[result.PaymentId!] = new Payment(result.PaymentId!, r.Amount, "succeeded");
        return Task.FromResult(result);
    }
    public Task<Payment?> GetPaymentAsync(string id, CancellationToken ct = default) => Task.FromResult(_payments.GetValueOrDefault(id));
}
~~~`,
  pts: [r`The SDK's public API is a small, stable inbound port.`, r`Transport, clock, auth and retry are replaceable outbound dependencies.`, r`Ship test doubles so consumers test without the network.`, r`Extension points and decorators instead of forks; semantic versioning and API analyzers.`, r`Plug-in platforms: contracts both ways, isolation, contract test kits.`],
  ex: r`An internal payments SDK without a fake forced 40 consumer services to mock HttpClient internals; an SDK update broke most of their tests. Shipping a FakePaymentsClient and a narrow interface removed that coupling and made SDK upgrades routine.`,
  fu: [r`How do you detect breaking changes in a public API?`, r`How do you deprecate an SDK method?`, r`How do you isolate untrusted plug-ins?`],
  pit: [r`Large public surfaces exposing internals.`, r`No test doubles for consumers.`, r`Breaking changes without versioning.`] },

{ id: 'q49', level: 'Principal', tags: ['hexagonal', 'open-banking', 'psd2', 'aggregators'],
  q: r`Build an open-banking account-information and payment-initiation service connecting to many banks (directly via PSD2 APIs and through aggregators such as TrueLayer or Plaid). Design the ports, adapters, consent handling and the variability across banks.`,
  a: r`### Core concepts
Consents (scope, expiry, re-authentication every 90/180 days depending on regulation), connections per customer and bank, account information (balances, transactions), payment initiation with status tracking, and strong customer authentication (SCA) redirects.

### Ports
- {{IBankConnections}}: start consent (returns an SCA redirect), complete consent (callback), refresh/revoke.
- {{IAccountInformation}}: accounts, balances, transactions (paged, as-of dates).
- {{IPaymentInitiation}}: initiate payment (returns SCA redirect), get status.
- Explicit outcomes: consent expired, SCA required, bank unavailable, rate limited, unsupported capability.

### Adapters
- **Direct bank adapters** for strategic banks (Berlin Group, UK Open Banking standards, bank-specific quirks).
- **Aggregator adapters** covering long tails.
- A **routing adapter** choosing per bank (capability, cost, reliability), with **capability flags** (supports scheduled payments, supports variable recurring payments).

### Variability
Standards differ by country and bank (date formats, pagination, transaction categorisation, booking vs value dates); normalisation in adapters to the core's model with original data kept for audit.

### Reliability and compliance
Rate limits per bank (PSD2 allows limited unattended access per day), caching of account data with freshness, consent lifecycle notifications, audit of every access, regulatory licences (AISP/PISP) and certificates (eIDAS QWAC/QSealC) handled in adapters.`,
  code: r`~~~csharp
public interface IBankConnections
{
    Task<ConsentStart> StartConsentAsync(CustomerId c, BankId bank, ConsentScope scope, Uri redirect, CancellationToken ct);
    Task<Consent> CompleteConsentAsync(string state, string authorisationCode, CancellationToken ct);
}
public interface IAccountInformation
{
    Task<Result<IReadOnlyList<BankAccount>, BankError>> AccountsAsync(Consent consent, CancellationToken ct);
    IAsyncEnumerable<BankTransaction> TransactionsAsync(Consent consent, string accountId, DateOnly from, CancellationToken ct);
}
public abstract record BankError
{
    public sealed record ConsentExpired : BankError;
    public sealed record ScaRequired(Uri Redirect) : BankError;
    public sealed record RateLimited(TimeSpan RetryAfter) : BankError;
    public sealed record Unsupported(string Capability) : BankError;
    public sealed record Unavailable : BankError;
}

// Routing by bank: direct adapter for strategic banks, aggregator for the long tail
internal sealed class RoutingAccountInformation(IBankDirectory banks, IReadOnlyDictionary<string, IAccountInformation> adapters) : IAccountInformation
{
    public Task<Result<IReadOnlyList<BankAccount>, BankError>> AccountsAsync(Consent c, CancellationToken ct) => adapters[banks.ChannelFor(c.Bank)].AccountsAsync(c, ct);
    public IAsyncEnumerable<BankTransaction> TransactionsAsync(Consent c, string acc, DateOnly from, CancellationToken ct) => adapters[banks.ChannelFor(c.Bank)].TransactionsAsync(c, acc, from, ct);
}
~~~`,
  pts: [r`Core models consents, connections, accounts, payments and SCA.`, r`Ports with explicit outcomes: consent expired, SCA required, rate limited, unsupported.`, r`Direct bank adapters plus aggregators behind a routing adapter with capability flags.`, r`Normalise bank variability in adapters; keep originals for audit.`, r`Rate limits, consent lifecycle, audit and certificates handled deliberately.`],
  ex: r`A lending platform relied on one aggregator for bank data; an aggregator outage stopped affordability checks for a day. Adding direct adapters for the five banks covering 70% of customers, behind the same port with routing, made the next aggregator outage a partial degradation.`,
  fu: [r`How do you handle the 90-day re-consent requirement in the UX?`, r`How do you normalise transaction categories across banks?`, r`How do you test against bank sandboxes that differ from production?`],
  pit: [r`Aggregator-shaped core models.`, r`Ignoring unattended-access rate limits.`, r`Losing original bank data during normalisation.`] },

{ id: 'q50', level: 'Principal', tags: ['hexagonal', 'metrics', 'business-value', 'leadership'],
  q: r`Six months after introducing ports and adapters across a platform, the CTO asks: "Was it worth it?" How do you measure and present the value, and what would make you scale it back?`,
  a: r`### Metrics tied to the promises
| Promise | Metric |
|---|---|
| Faster, safer change of business rules | lead time for rule changes; defects escaped per release in core logic |
| Fast feedback | CI time for core tests; flaky test rate |
| Cheaper integration changes | effort/time for provider or protocol changes (before vs after); number of places touched |
| Resilience | incidents caused by dependencies; mean time to detect and mitigate; degraded-mode success |
| Test environment independence | days blocked by external test environments |
| Onboarding | time to first PR / first feature |

### Evidence
- Before/after comparisons on the same team and similar work.
- Case studies: the provider migration that took 3 weeks instead of 3 months; the outage contained by a circuit breaker and degraded mode.
- Cost side: extra code, adapter maintenance, simulator upkeep, training time.

### When to scale back
- Services where ports added only indirection (CRUD, short-lived tools): simplify.
- Ports that never had a second implementation or test use and protect nothing volatile: inline.
- Simulators whose fidelity cost exceeds their value: replace with recorded fixtures.

### Presenting
Lead with business outcomes (lead time, incidents, provider leverage), then costs, then the adjustments you will make. Architecture is justified by results, not by elegance.`,
  code: r`~~~text
Quarterly architecture value report (excerpt)

Metric                                   Before (Q1)   After (Q3)
Core rule change lead time (median)      9 days        2.5 days
Escaped defects in payment logic         7             2
Core test stage duration                 31 min        74 s
Provider switch (Adyen segment)          est. 12 wks   3 wks actual
Incidents from dependency outages        5 (2 major)   4 (0 major; degraded modes held)
Days blocked by vendor test envs         38            4

Costs: +11% code in adapters/contract tests; 1.5 FTE simulator upkeep.
Adjustments: inline 23 internal interfaces in back-office services; replace KYC simulator with recorded fixtures.
~~~
~~~csharp
// Lead-time metric from the deployment pipeline: rule-change PRs tagged by path
// SELECT AVG(DATEDIFF(hour, first_commit_at, deployed_at)) FROM deployments WHERE paths LIKE '%Core/Rules/%' AND quarter = @q;
~~~`,
  pts: [r`Measure the promises: lead time, defects, CI time, integration effort, incidents, environment independence.`, r`Use before/after comparisons and concrete case studies.`, r`Account for costs: code, adapters, simulators, training.`, r`Scale back where ports add only indirection.`, r`Present outcomes first; adjust based on evidence.`],
  ex: r`A CTO review almost cancelled a platform's simulator programme as overhead until the report showed 34 fewer blocked days per quarter and a provider migration completed in a quarter of the estimated time; the review instead funded it and cut two low-value simulators.`,
  fu: [r`How do you attribute improvements to architecture rather than other changes?`, r`Which metric would you track first?`, r`How often should the review happen?`],
  pit: [r`Justifying architecture by elegance.`, r`Ignoring costs.`, r`Never scaling back what does not pay.`] }
],
cheat: r`### The idea (Cockburn, 2005)
Application core inside; ports (core-owned contracts) at the edge; adapters outside translate to technology. UI and database are both outside. The same core is driven equally by users, programs, tests and batch scripts, and runs against real, simulated or in-memory dependencies.

### Two sides
| | Driving (primary) | Driven (secondary) |
|---|---|---|
| Initiator | outside calls core | core calls outside |
| Port | inbound: use case (IPlaceOrder) | outbound: dependency (IOrderStore, IExchangeGateway) |
| Adapter | REST, gRPC, FIX acceptor, consumer, scheduler, CLI, test harness, replay | SQL store, vendor client, publisher (outbox), simulator, fake |
| Relation | calls port | implements port |
Both sides depend on the core.

### Good ports
Domain language, neutral types, async + CancellationToken for I/O, documented semantics (idempotency, ordering, outcomes: rejected / unavailable / unknown / stale), capability-sized (not system-sized, not per call), batch methods for sets, contract suite shipped with the port. Technology-shaped ports (IDbPort, IHttpSender) defeat the purpose.

### What becomes a port
External systems, infrastructure, non-determinism (TimeProvider, randomness, ids), anything substituted for tests/environments or likely to change. Pure domain logic stays concrete. Each port = long-term commitment.

### Testing
Fakes (state-based) > mocks. Contract suite per port runs against fake, simulator, sandbox, real. Acceptance scenarios through inbound ports (thousands in seconds). Adapter tests verify translation only. Pact for internal providers; recorded fixtures + nightly sandboxes for vendors. Simulators with control planes; replay adapters with recorded inputs, fake clock and seeds; fault-injecting decorators.

### Environments
Adapters chosen by configuration in the composition root; fail startup if fakes/simulators configured in production; keep test adapters out of production images; report active adapter in health checks.

### Adapter responsibilities
Protocol mechanics (FIX sessions, ISO 8583 framing, ISO 20022), semantic translation (unknown codes fail loudly), resilience (timeouts, retries for idempotent calls, breakers, bulkheads), credentials and PCI scope (tokenise at edge, detokenise in scheme adapter), instrumentation via decorators. Never business rules; degradation decisions belong to the core.

### Patterns
Routing / failover (only when the call certainly did not land) / composite adapters; provider affinity for follow-ups; branch by abstraction with shadow mode; per-tenant adapters with per-tenant breakers; stand-in processing with store-and-forward; outbox behind a publisher port; one reference-data snapshot per decision.

### Principal moves
Deterministic cores enable replay-based regulatory evidence. Govern ports with a catalogue, semantics standard and fitness functions, not committees. Inline single-implementation internal interfaces. Multi-PSP: provider-independent tokens, capability flags, approval-rate business case. Cloud portability at capability level; exit plans, not abstractions of everything. LLMs behind validated capability ports with provenance and evaluation gates. Measure lead time, CI time, integration effort, incidents, blocked days.`
});
})(String.raw);
