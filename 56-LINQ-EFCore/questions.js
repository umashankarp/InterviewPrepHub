(function (r) {
registerTopic('56-linq-efcore', {
related: ['01-csharp', '04-sql-server', '02-dotnet-aspnetcore'],
questions: [
{ id: 'q1', level: 'Basic', tags: ['linq', 'deferred-execution', 'expression-trees'],
  q: r`What actually happens when a LINQ query runs? Explain deferred vs immediate execution, IEnumerable vs IQueryable, and Func vs Expression<Func>.`,
  a: r`### Two different machines behind the same syntax
| | LINQ to Objects | LINQ to a provider (EF Core) |
|---|---|---|
| Source type | {{IEnumerable<T>}} | {{IQueryable<T>}} |
| Lambda compiled to | a **delegate** ({{Func<T,bool>}}) | an **expression tree** ({{Expression<Func<T,bool>>}}): data describing the code |
| Who executes | your process, iterator by iterator | the provider **translates** the tree (to SQL) and the database executes it |
| Unsupported method | just runs | throws "could not be translated" |

The compiler picks the overload from the **static type**. The moment a query is typed as {{IEnumerable<T>}} (an {{AsEnumerable()}}, a method parameter of type IEnumerable, a {{ToList()}}), every following operator runs **in memory** on whatever rows were fetched.

### Deferred vs immediate
- **Deferred** (streaming or buffered iterators): {{Where}}, {{Select}}, {{OrderBy}}, {{GroupBy}}, {{Take}}. Building the query does nothing; it runs when enumerated.
- **Immediate**: {{ToList}}, {{ToArray}}, {{ToDictionary}}, {{Count}}, {{First}}, {{Any}}, {{Sum}}, {{Max}}.
- Enumerating a deferred query **twice runs it twice**: two SQL round trips, or two passes over a generator with side effects.
- Captured variables are read **at execution time**, not at definition time.

### Streaming vs buffering inside LINQ to Objects
{{Where}} and {{Select}} stream one element at a time; {{OrderBy}}, {{GroupBy}}, {{Reverse}} and {{Distinct}} must **buffer** the input before yielding the first result. That matters for memory on large sequences and for infinite sequences.`,
  code: r`~~~csharp
IQueryable<Payment> q = db.Payments.Where(p => p.Status == Status.Pending);   // Expression<Func<..>>; nothing executed

var bad  = db.Payments.AsEnumerable().Where(p => p.MerchantId == id).ToList(); // loads EVERY payment, filters in memory
var good = await q.Where(p => p.MerchantId == id).OrderBy(p => p.Id).Take(50).ToListAsync(ct); // one SQL query

// Same lambda, two compilations
Func<Payment, bool> asDelegate = p => p.Amount > 100;                 // IL: runs in-process
Expression<Func<Payment, bool>> asTree = p => p.Amount > 100;         // data: a provider can read it
Console.WriteLine(asTree.Body);                                        // (p.Amount > 100)

// Deferred execution reads captured variables late
var threshold = 100m;
var big = payments.Where(p => p.Amount > threshold);
threshold = 1_000m;
var count = big.Count();          // uses 1,000, not 100

// Multiple enumeration: two database round trips
IEnumerable<Payment> pending = db.Payments.Where(p => p.Status == Status.Pending);
if (pending.Any()) Process(pending.ToList());       // query 1 (EXISTS), query 2 (SELECT)
~~~`,
  pts: [r`IEnumerable lambdas are delegates; IQueryable lambdas are expression trees a provider translates.`, r`The static type decides: after AsEnumerable or ToList everything runs in memory.`, r`Deferred operators run on enumeration; immediate ones (ToList, Count, First) run now.`, r`Enumerating twice executes twice; captured variables are read at execution.`, r`OrderBy, GroupBy, Distinct buffer; Where and Select stream.`],
  ex: r`A repository method returned IEnumerable<Order> "to hide EF". Callers then added .Where(o => o.CustomerId == id), which ran in memory after loading 4 million orders per call. Changing the return type to IQueryable inside the data layer (and DTOs outside it) turned a 12-second call into 8 ms.`,
  fu: [r`Why does a method parameter typed as IEnumerable<T> silently disable SQL translation?`, r`How does the provider turn a captured variable into a SQL parameter?`, r`Which LINQ to Objects operators buffer, and why does it matter for an infinite generator?`],
  pit: [r`AsEnumerable() or ToList() before filtering.`, r`Returning IEnumerable from the data layer and composing on it.`, r`Calling Any() then ToList() on the same query.`] },

{ id: 'q2', level: 'Basic', tags: ['linq', 'operators', 'grouping', 'joins'],
  q: r`Which LINQ operators do you use for grouping, joining and set logic, and how do GroupBy, ToLookup, GroupJoin, SelectMany and the newer .NET 6 to 10 operators behave?`,
  a: r`### Grouping
- {{GroupBy}} is **deferred**; it buffers the source on enumeration and re-groups every time you enumerate it.
- {{ToLookup}} is **immediate**: builds an {{ILookup<TKey,T>}} once; missing keys return an **empty sequence**, not an exception. Use it when you will look groups up repeatedly.
- {{ToDictionary}} throws on duplicate keys, which is a useful assertion.
- .NET 9: {{CountBy(k)}} and {{AggregateBy(k, seed, func)}} aggregate per key without materialising groups; {{Index()}} yields (index, item) pairs.

### Joining
- {{Join}}: inner join on keys (hash join in memory).
- {{GroupJoin}}: each outer element with a sequence of matches; plus {{SelectMany(... DefaultIfEmpty())}} is the classic **left join**. .NET 10 adds {{LeftJoin}} and {{RightJoin}} operators (EF Core 10 translates them).
- {{SelectMany}}: flattens one-to-many (orders to lines); also the cross join.
- {{Zip}}: pairs two sequences by position.

### Sets and selection
{{Distinct}}, {{Union}}, {{Intersect}}, {{Except}} use the default equality (records compare by value, classes by reference). The **By** variants ({{DistinctBy}}, {{UnionBy}}, {{ExceptBy}}, {{IntersectBy}}, .NET 6) compare on a key. {{MinBy}} / {{MaxBy}} return the element, not the value. {{Chunk(n)}} batches; {{Take(range)}} and {{TakeLast}} slice.

### Quantifiers and element access
{{Any()}} stops at the first element; {{Count() > 0}} may count everything (on a non-collection). {{First}} throws if empty, {{FirstOrDefault}} returns default, {{Single}} throws if more than one: choose the one that **asserts your assumption**.`,
  code: r`~~~csharp
// Lookup once, query many times; missing key = empty sequence
ILookup<long, Payment> byMerchant = payments.ToLookup(p => p.MerchantId);
var forM42 = byMerchant[42];

// Totals per currency without building groups (.NET 9)
foreach (var (ccy, total) in payments.AggregateBy(p => p.Currency, 0m, (sum, p) => sum + p.Amount))
    Console.WriteLine($"{ccy}: {total}");
var countsByStatus = payments.CountBy(p => p.Status);

// Left join: customers with their orders, including customers with none
var rows =
    from c in customers
    join o in orders on c.Id equals o.CustomerId into g
    from o in g.DefaultIfEmpty()
    select new { c.Name, OrderId = o?.Id };
var rows10 = customers.LeftJoin(orders, c => c.Id, o => o.CustomerId,
                                (c, o) => new { c.Name, OrderId = o?.Id });     // .NET 10

// Flatten orders into lines, then batch for an API that accepts 500 at a time
foreach (var batch in orders.SelectMany(o => o.Lines).Chunk(500))
    await pricing.RepriceAsync(batch, ct);

// Element by key, set difference by key
var largest = payments.MaxBy(p => p.Amount);
var unmatched = bankLines.ExceptBy(ledger.Select(l => l.Reference), b => b.Reference);
~~~`,
  pts: [r`GroupBy is deferred and re-runs; ToLookup builds once and tolerates missing keys.`, r`GroupJoin + SelectMany + DefaultIfEmpty is the left join; .NET 10 adds LeftJoin.`, r`DistinctBy, ExceptBy, MinBy, MaxBy, Chunk (.NET 6); CountBy, AggregateBy, Index (.NET 9).`, r`Any() short-circuits; prefer it to Count() > 0.`, r`First, Single, FirstOrDefault: pick the one that asserts your expectation.`],
  ex: r`A reconciliation job grouped 2 million bank lines with GroupBy inside a loop over 40,000 references, regrouping on every iteration (40 minutes). One ToLookup outside the loop cut it to 9 seconds.`,
  fu: [r`Why does Except on a list of class instances return everything, and how do you fix it?`, r`Which of these operators does EF Core translate to SQL, and which force client evaluation?`, r`When would you use Single instead of First in production code?`],
  pit: [r`GroupBy enumerated repeatedly inside a loop.`, r`Count() > 0 on IEnumerable instead of Any().`, r`FirstOrDefault hiding a data bug that Single would have surfaced.`] },

{ id: 'q3', level: 'Basic', tags: ['ef-core', 'dbcontext', 'unit-of-work', 'di'],
  q: r`What is a DbContext, why is its lifetime "one unit of work", and what breaks if it is long-lived or shared?`,
  a: r`A {{DbContext}} is a **Unit of Work plus identity map**: entities become tracked when queried or added, you change them, {{SaveChanges}} writes the **diff** in one transaction, then you dispose it.

{{AddDbContext}} registers it **scoped**: one HTTP request equals one unit of work shared by handler, repository and audit service (one tracker, one transaction).

### What breaks when it lives too long
1. **Memory**: the change tracker keeps every entity it materialised plus a snapshot; it never forgets on its own.
2. **Staleness**: the identity map returns the **already-tracked instance** for a second query of the same row, without refreshing its values.
3. **Cost**: {{DetectChanges}} is proportional to tracked entities, so every SaveChanges gets slower.
4. **Concurrency**: shared across threads it is unsupported (and in a singleton it is shared by every request).

### What a context is not
- Not a connection: EF opens the connection late and closes it early (unless you open it or hold a transaction).
- Not expensive: the **model** is built once per process and cached; creating a context per request is cheap.
- Not recoverable after some errors: an {{InvalidOperationException}} from EF "can put the context into an unrecoverable state"; dispose and start again. After a failed SaveChanges the tracker still holds the pending changes.

### Lifetime by host
| Host | Lifetime |
|---|---|
| ASP.NET Core request | scoped (default) |
| BackgroundService / worker | {{IDbContextFactory<T>}}: one context per batch |
| Blazor Server | factory (a circuit lives for minutes) |
| Parallel work | one context per task |`,
  code: r`~~~csharp
builder.Services.AddDbContext<PaymentsDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Payments")));

// Catch captive dependencies (a scoped context inside a singleton) at startup, in every environment
builder.Host.UseDefaultServiceProvider(o => { o.ValidateScopes = true; o.ValidateOnBuild = true; });

// One request = one unit of work
app.MapPost("/payments/{id:guid}/capture", async (Guid id, PaymentsDbContext db, CancellationToken ct) =>
{
    var payment = await db.Payments.SingleAsync(p => p.Id == id, ct);   // tracked
    payment.Capture();                                                    // domain method changes state
    await db.SaveChangesAsync(ct);                                        // one UPDATE, one transaction
    return Results.NoContent();
});

// The staleness trap in a long-lived context
var a = await db.Accounts.SingleAsync(x => x.Id == 1, ct);   // Balance 100
// ... another process updates the row to 50 ...
var b = await db.Accounts.SingleAsync(x => x.Id == 1, ct);   // same instance, Balance still 100
await db.Entry(a).ReloadAsync(ct);                            // explicit refresh if you really need it
~~~`,
  pts: [r`DbContext = Unit of Work + identity map; short-lived, disposed after SaveChanges.`, r`Scoped by default: one request, one tracker, one transaction.`, r`Long-lived contexts leak memory, return stale tracked instances and slow DetectChanges.`, r`Context is cheap (model cached); it is not a connection.`, r`Workers and Blazor use IDbContextFactory; ValidateScopes catches captive contexts.`],
  ex: r`A pricing worker held one DbContext for the life of the process. After two days it tracked 9 million entities (6 GB) and kept pricing with an FX rate from Monday because the identity map never re-read it. A context per batch from IDbContextFactory fixed both the memory and the stale rate.`,
  fu: [r`When is a transient DbContext registration correct?`, r`What does ChangeTracker.Clear() do, and when would you call it?`, r`How do you detect a captive DbContext in an existing codebase?`],
  pit: [r`Singleton DbContext "for performance".`, r`Expecting a re-query to refresh an already-tracked entity.`, r`Continuing to use a context after an EF InvalidOperationException.`] },

{ id: 'q4', level: 'Basic', tags: ['ef-core', 'threading', 'async', 'parallelism'],
  q: r`A colleague runs Task.WhenAll over two ToListAsync calls on the injected DbContext. What happens, and how do you run database work in parallel correctly?`,
  a: r`EF Core does **not** support more than one operation at a time on a context instance, **including async operations**. Starting a second while the first is in flight throws "**A second operation was started on this context instance before a previous operation completed**". Detection is best-effort: undetected concurrent use is undefined behaviour, crashes or **data corruption** in the change tracker.

### Usual causes
- {{Task.WhenAll}} over queries on the same context.
- A missing {{await}} (fire-and-forget query, then another query).
- {{async void}} event handlers.
- A context captured by a singleton and used by concurrent requests.
- {{Parallel.ForEachAsync}} workers sharing one context.

### Fixes
1. **Await sequentially.** Usually right: two indexed queries of 2 ms each cost 4 ms in sequence, and parallelism would take a second pooled connection to save 2 ms.
2. If parallelism genuinely pays (independent slow queries, fan-out over items), use **one context per task** from {{IDbContextFactory<T>}} (or a scope per task), and **bound concurrency to the connection budget**, not to CPU count.
3. Never disable {{EnableThreadSafetyChecks}} to "fix" the exception; it only removes the detector.

### Related async rules
- Always use the async methods ({{ToListAsync}}, {{SaveChangesAsync}}) in web code: synchronous calls block a thread-pool thread for the I/O duration and feed thread-pool starvation.
- Pass the request {{CancellationToken}} so abandoned requests stop their queries.`,
  code: r`~~~csharp
// Broken: two operations on one context at the same time
var t1 = db.Orders.Where(o => o.CustomerId == id).ToListAsync(ct);
var t2 = db.Invoices.Where(i => i.CustomerId == id).ToListAsync(ct);
await Task.WhenAll(t1, t2);   // InvalidOperationException, or worse if undetected

// Usually right: sequential
var orders   = await db.Orders.Where(o => o.CustomerId == id).ToListAsync(ct);
var invoices = await db.Invoices.Where(i => i.CustomerId == id).ToListAsync(ct);

// When parallel genuinely pays: one context per task, bounded by the connection budget
public sealed class ExposureCalculator(IDbContextFactory<RiskDbContext> factory)
{
    public async Task<decimal[]> ForDesksAsync(IReadOnlyList<int> deskIds, CancellationToken ct)
    {
        var results = new decimal[deskIds.Count];
        await Parallel.ForEachAsync(Enumerable.Range(0, deskIds.Count),
            new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },   // not Environment.ProcessorCount
            async (i, token) =>
            {
                await using var db = await factory.CreateDbContextAsync(token);
                results[i] = await db.Positions.Where(p => p.DeskId == deskIds[i]).SumAsync(p => p.Exposure, token);
            });
        return results;
    }
}
~~~`,
  pts: [r`One operation at a time per context, async included.`, r`Detection is best-effort; undetected misuse corrupts state.`, r`Sequential awaits are usually the right answer.`, r`Parallel: one context per task via IDbContextFactory, bounded by the connection budget.`, r`Async APIs and cancellation tokens everywhere in web code.`],
  ex: r`A dashboard endpoint fired eight queries with Task.WhenAll on the scoped context. It "worked" in development, where queries finished before the next started, and threw in production under latency. Sequential awaits were 30 ms slower; a factory-based fan-out of 3 recovered the time without exhausting the pool.`,
  fu: [r`How would you fan out 500 items safely against a pool of 25 connections per pod?`, r`What analyzer rules catch un-awaited tasks?`, r`Why does sync-over-async in EF code contribute to thread-pool starvation?`],
  pit: [r`Task.WhenAll on one context.`, r`Disabling thread-safety checks.`, r`MaxDegreeOfParallelism = ProcessorCount for I/O-bound database work.`] },

{ id: 'q5', level: 'Basic', tags: ['ef-core', 'modeling', 'conventions', 'money'],
  q: r`Conventions, data annotations and the Fluent API: what is the precedence, where should configuration live, and which defaults bite a financial system (strings, decimal(18,2), money)?`,
  a: r`### Precedence
**Conventions** (lowest) → **data annotations** → **Fluent API** (highest). Keep configuration out of domain classes: one {{IEntityTypeConfiguration<T>}} per entity, loaded with {{ApplyConfigurationsFromAssembly}}, and **bulk rules in {{ConfigureConventions}}**.

### Defaults that bite on SQL Server
| Default | Problem | Fix |
|---|---|---|
| {{string}} → {{nvarchar(max)}} | cannot be an index key; off-row storage; memory grants | {{HaveMaxLength}} globally; {{IsUnicode(false)}} for ASCII codes |
| {{decimal}} → {{decimal(18,2)}} (with a warning) | silently rounds FX rates and amounts at the database boundary: 1.23456 becomes 1.23 | {{HavePrecision(19,4)}}; rates {{(28,10)}} |
| NRT-enabled {{string}} → NOT NULL | surprising required columns | intentional nullability |
| Required relationship → **cascade delete** | deletes through ledgers | explicit {{OnDelete(Restrict)}} |
| {{DateTime}} | kind lost on round trip | UTC converter or {{DateTimeOffset}} |

### Money
Model **Money as a value object** (amount + currency, never separate loosely coupled columns), mapped as a **complex type**. Two defensible storage designs:
- **Scaled decimal** {{decimal(19,4)}} plus {{char(3)}} currency: natural to read; rounding policy in code.
- **Minor units** {{bigint}} plus currency: exact integers, cheap sums, but needs a per-currency exponent table (JPY 0, USD 2, BHD 3).

Never {{double}} or {{float}}. On the wire send amounts as **strings** (JSON numbers lose precision in JavaScript).

### Make the safe choice the default
The model is built lazily at first use, so add a **model-rule test** that loads {{db.Model}} and fails on unbounded strings or default-precision decimals. And **read every generated migration**.`,
  code: r`~~~csharp
public sealed class PaymentsDbContext(DbContextOptions<PaymentsDbContext> options) : DbContext(options)
{
    protected override void ConfigureConventions(ModelConfigurationBuilder c)
    {
        c.Properties<string>().HaveMaxLength(256);
        c.Properties<decimal>().HavePrecision(19, 4);
        c.Properties<DateTime>().HaveConversion<UtcDateTimeConverter>();
    }
    protected override void OnModelCreating(ModelBuilder mb) =>
        mb.ApplyConfigurationsFromAssembly(typeof(PaymentsDbContext).Assembly);
}

public sealed record Money(decimal Amount, string Currency);

public sealed class PaymentConfiguration : IEntityTypeConfiguration<Payment>
{
    public void Configure(EntityTypeBuilder<Payment> b)
    {
        b.ComplexProperty(p => p.Amount, m =>
        {
            m.Property(x => x.Amount).HasColumnName("Amount").HasPrecision(19, 4);
            m.Property(x => x.Currency).HasColumnName("Currency").HasMaxLength(3).IsUnicode(false).IsFixedLength();
        });
        b.Property(p => p.Reference).HasMaxLength(35).IsUnicode(false);     // ISO 20022 end-to-end id
        b.Property(p => p.FxRate).HasPrecision(28, 10);
        b.ToTable(t => t.HasCheckConstraint("CK_Payments_Amount_Positive", "[Amount] > 0"));
    }
}

// Model-rule test: fail the build on unsafe defaults
[Fact]
public void No_unbounded_strings_or_default_decimals()
{
    using var db = TestDb.Create();
    var bad = db.Model.GetEntityTypes().SelectMany(e => e.GetProperties())
        .Where(p => (p.ClrType == typeof(string) && p.GetMaxLength() is null)
                 || (p.ClrType == typeof(decimal) && (p.GetPrecision() ?? 18) == 18 && (p.GetScale() ?? 2) == 2))
        .Select(p => $"{p.DeclaringType.DisplayName()}.{p.Name}");
    Assert.Empty(bad);
}
~~~`,
  pts: [r`Fluent API beats annotations beats conventions; configuration classes, not attributes on domain types.`, r`ConfigureConventions for global rules: string length, decimal precision, UTC dates.`, r`decimal(18,2) and nvarchar(max) are the two defaults that bite.`, r`Money is a value object (amount + currency) mapped as a complex type; never float.`, r`A model-rule test makes unsafe defaults fail the build.`],
  ex: r`A treasury service stored FX rates with the default decimal(18,2); 1.087643 EUR/USD was saved as 1.09. Conversions were off by up to 0.2% for three weeks before reconciliation caught a 410,000 USD difference. A global precision convention and a model-rule test stopped it recurring.`,
  fu: [r`How would you store amounts for currencies with 0 and 3 minor units in the same table?`, r`Why can an nvarchar(max) column not be an index key, and what does it do to memory grants?`, r`How do you make the build fail on a migration that drops a column?`],
  pit: [r`Fixing defaults property by property instead of with conventions.`, r`double for money.`, r`Never reading generated migrations.`] },

{ id: 'q6', level: 'Basic', tags: ['ef-core', 'change-tracking', 'performance'],
  q: r`Tracking vs AsNoTracking vs AsNoTrackingWithIdentityResolution: what does each cost, what are the semantics (identity resolution, fix-up, stale reads), and what is your default?`,
  a: r`### Tracking (default)
Every materialised entity is registered in the change tracker with a **snapshot** of its original values, so {{SaveChanges}} can compute the diff. Tracking also performs **identity resolution**: if a row is already tracked, the query returns **the existing instance and does not overwrite its values** with fresh database values (stale reads in a long-lived context).

**Fix-up** connects navigations between tracked entities automatically, so a collection can look loaded while containing only the children that happen to be tracked (**partial collections**).

### AsNoTracking
No registration, no snapshot, no identity resolution: the cheapest option. If a query returns the same customer for 100 orders, you get **100 customer instances**.

### AsNoTrackingWithIdentityResolution
Untracked, but **de-duplicates instances within the query** using a temporary identity map that is discarded afterwards. Use it for read-only graphs loaded with {{Include}}.

### Projections
Projecting into a DTO or anonymous type with only scalar values is **never tracked**. An entity *inside* a projection (an anonymous type with an {{Order = o}} member) **is** tracked.

### Defaults I set
- Read-heavy services: {{UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking)}} at the context, then opt in with {{AsTracking()}} for write paths.
- API reads: project to DTOs.
- Write paths: tracked queries, change via domain methods, {{SaveChanges}}.

Untracked entities cannot be modified and saved without {{Attach}} or {{Update}}, which brings the disconnected-entity rules into play.`,
  code: r`~~~csharp
// Read-heavy context: untracked by default
builder.Services.AddDbContext<ReportingDbContext>(o => o
    .UseSqlServer(cs)
    .UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));

// API read: projection, never tracked, only the needed columns
var dto = await db.Orders.Where(o => o.Id == id)
    .Select(o => new OrderDto(o.Id, o.Total, o.Customer.Name, o.Lines.Count))
    .SingleOrDefaultAsync(ct);

// Read-only graph: no tracking, but one Customer instance per customer
var orders = await db.Orders.Include(o => o.Customer)
    .Where(o => o.CreatedUtc >= since)
    .AsNoTrackingWithIdentityResolution()
    .ToListAsync(ct);

// Write path: tracked
var account = await db.Accounts.AsTracking().SingleAsync(a => a.Id == accountId, ct);
account.Freeze(reason);
await db.SaveChangesAsync(ct);

// Inspect what is tracked when debugging
Console.WriteLine(db.ChangeTracker.DebugView.ShortView);
~~~`,
  pts: [r`Tracking = registration + snapshot + identity resolution; costs CPU and memory.`, r`Identity resolution returns the tracked instance without refreshing values.`, r`AsNoTracking is cheapest but duplicates shared instances; WithIdentityResolution dedupes per query.`, r`Scalar projections are never tracked; entities inside projections are.`, r`Default: no-tracking for read services, DTO projections for APIs, tracking only on write paths.`],
  ex: r`A statement API loaded 5,000 transactions tracked for every request; profiling showed 38% of CPU in snapshot creation. Switching the read context to NoTracking and projecting to DTOs halved CPU and let the team drop two of six pods.`,
  fu: [r`What is fix-up, and how can it produce a partially loaded collection?`, r`Why is an entity inside an anonymous projection still tracked?`, r`How do you modify and save an entity that was loaded with AsNoTracking?`],
  pit: [r`Tracking every query in a read-only API.`, r`Assuming a second query refreshes a tracked entity.`, r`Using AsNoTracking with Include on deep graphs and getting thousands of duplicate instances.`] },

{ id: 'q7', level: 'Intermediate', tags: ['ef-core', 'query-pipeline', 'translation'],
  q: r`Walk through how EF Core turns db.Payments.Where(...).ToListAsync() into objects. Where do client evaluation, the query cache and parameterisation fit in?`,
  a: r`### The pipeline
1. The lambda is an **expression tree**, composed by each operator.
2. **Preprocessing**: captured variables are extracted as **parameters**, navigations are expanded to joins, the tree is normalised.
3. **Query cache lookup**, keyed by the tree **shape** (not parameter values). Hit: reuse the compiled SQL and shaper. Miss: **translate** to a SQL expression tree, generate SQL text, and compile the **shaper** (the code that turns a {{DbDataReader}} row into objects).
4. **Execute**: a connection from the ADO.NET pool, a parameterised command.
5. **Materialise** rows through the shaper.
6. If tracking: **identity resolution** and snapshot registration.

### Client evaluation
Since EF Core 3.0 only the **final projection** may run on the client (for example calling a C# method to format a DTO field). An untranslatable filter or ordering throws "**could not be translated... insert a call to AsEnumerable or ToList**". That exception is a feature; the dangerous fix is following its advice blindly and pulling a whole table into memory.

### What translates
Most operators, string methods ({{Contains}}, {{StartsWith}}), date parts, {{EF.Functions}} ({{Like}}, {{DateDiffDay}}, {{Collate}}), math, {{GroupBy}} with aggregates, {{LeftJoin}} (EF 10). {{DateTime.UtcNow}} becomes {{SYSUTCDATETIME()}} evaluated by the server. Your own C# methods do not translate, unless mapped with {{HasDbFunction}} to a SQL function.

### Seeing the SQL
{{ToQueryString()}} in tests and debugging, {{LogTo}} or {{ILogger}} category {{Microsoft.EntityFrameworkCore.Database.Command}}, and {{TagWith}} so the query is attributable in Query Store and APM.`,
  dia: r`flowchart LR
  A[LINQ expression tree] --> B[Preprocess: parameters, navigation expansion]
  B --> C{Query cache hit by shape}
  C -- miss --> D[Translate to SQL tree, generate SQL, compile shaper]
  D --> E[Cache]
  C -- hit --> F[Execute parameterised command]
  E --> F
  F --> G[Shaper materialises rows]
  G --> H{Tracking}
  H -- yes --> I[Identity resolution and snapshot]
  H -- no --> J[Return objects]
  I --> J`,
  code: r`~~~csharp
var since = DateTime.UtcNow.AddDays(-7);
var query = db.Payments
    .TagWith("Payments.RecentFailed")
    .Where(p => p.Status == PaymentStatus.Failed && p.CreatedUtc >= since)   // 'since' becomes @__since_0
    .OrderByDescending(p => p.CreatedUtc)
    .Select(p => new FailedPaymentDto(p.Id, p.Amount.Amount, FormatReason(p.FailureCode)));  // client eval allowed: final projection
Console.WriteLine(query.ToQueryString());

// Throws: filter cannot be translated (IsHighRisk is a C# method)
// db.Payments.Where(p => riskEngine.IsHighRisk(p)).ToListAsync();

// Map a SQL function so it translates instead of forcing client evaluation
modelBuilder.HasDbFunction(typeof(SqlFns).GetMethod(nameof(SqlFns.BusinessDaysBetween))!)
            .HasName("fn_BusinessDaysBetween").HasSchema("dbo");
var late = await db.Invoices
    .Where(i => SqlFns.BusinessDaysBetween(i.DueDate, DateTime.UtcNow) > 30)
    .ToListAsync(ct);

// Provider functions
var matches = await db.Customers.Where(c => EF.Functions.Like(c.Name, "Smith%")).ToListAsync(ct);
~~~`,
  pts: [r`Expression tree → preprocess (parameters) → cache by shape → translate + compile shaper → execute → materialise → track.`, r`Captured variables become SQL parameters; constants change the cache key.`, r`Client evaluation only in the final projection; untranslatable filters throw.`, r`HasDbFunction maps C# stubs to SQL functions; EF.Functions exposes provider features.`, r`ToQueryString, LogTo and TagWith make the SQL visible and attributable.`],
  ex: r`An engineer "fixed" a translation exception by inserting ToList() before a Where on IsHighRisk(). The endpoint started loading 3 million payments per call. Mapping the rule to a SQL function with HasDbFunction restored server-side filtering.`,
  fu: [r`Why is EF Core overhead usually negligible compared with database and network time?`, r`What does DateTime.UtcNow translate to, and is it evaluated once or per row?`, r`How do you unit-test that a query translates without a database?`],
  pit: [r`Following the exception's AsEnumerable advice without thinking.`, r`Assuming EF runs your C# in the database.`, r`Never looking at generated SQL.`] },

{ id: 'q8', level: 'Intermediate', tags: ['ef-core', 'n-plus-one', 'lazy-loading', 'performance'],
  q: r`A list endpoint takes 5 seconds in the cloud and 200 ms locally. Define N+1, show how you detect it in tests and production, fix it, and state your position on lazy loading.`,
  a: r`### The arithmetic
Load 1,000 parents (1 query), then touch a navigation per parent (1,000 queries): **1,001 round trips**. At 5 ms cloud latency that is about **5 seconds** for data one query returns in 10 ms. Locally, latency is 0.2 ms, so the bug hides.

### Causes
- **Lazy loading** proxies ({{UseLazyLoadingProxies}}) touched in a loop or by a serializer.
- Explicit queries inside a {{foreach}}.
- Mapping libraries walking navigations.

### Fixes, in order of preference
1. **Projection** into a DTO: {{Select(o => new { o.Id, LineCount = o.Lines.Count })}} becomes a correlated subquery or join in **one** statement.
2. **Eager loading** with {{Include}} / {{ThenInclude}} (filtered include allowed) when you need entities to modify.
3. **Batch** the children: one query {{Where(l => orderIds.Contains(l.OrderId))}} and group in memory.

### Detection that survives refactors
- A {{DbCommandInterceptor}} counts commands per test; assert the count is **independent of N** (seed 5 rows, then 500, assert equal counts).
- In production: a **queries-per-request** metric or span count in APM; the EF meter {{queries}} trending up per request.

### Lazy loading
It is an N+1 factory, it is **synchronous** (there is no async lazy load, so it blocks a thread on I/O), it fails after the context is disposed, and compiled models do not support proxies. I disallow it by policy on API and worker paths.`,
  code: r`~~~csharp
// N+1: one query for orders, then one per order for lines
var orders = await db.Orders.Where(o => o.CustomerId == id).ToListAsync(ct);
foreach (var o in orders) o.LineCount = db.Lines.Count(l => l.OrderId == o.Id);   // N more queries

// Fix: one query via projection
var rows = await db.Orders.Where(o => o.CustomerId == id)
    .Select(o => new OrderRow(o.Id, o.CreatedUtc, o.Lines.Count, o.Lines.Sum(l => l.Qty * l.UnitPrice)))
    .ToListAsync(ct);

// Test: query count must not grow with N
public sealed class CommandCounter : DbCommandInterceptor
{
    public int Count;
    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r, CancellationToken ct = default)
    { Interlocked.Increment(ref Count); return base.ReaderExecutingAsync(c, e, r, ct); }
}

[Theory, InlineData(5), InlineData(500)]
public async Task Order_list_uses_constant_number_of_queries(int n)
{
    var counter = new CommandCounter();
    await using var db = fixture.CreateContext(counter);
    await fixture.SeedOrdersAsync(n);
    await new OrderQueries(db).ListAsync(customerId: 1, CancellationToken.None);
    Assert.Equal(1, counter.Count);
}
~~~`,
  pts: [r`N+1 = 1 + N round trips; latency multiplies it, so it hides locally.`, r`Fix by projection first, Include when modifying, batched child loads otherwise.`, r`Command-count tests independent of N catch regressions.`, r`Queries-per-request metrics catch it in production.`, r`Lazy loading is synchronous and an N+1 factory: banned on hot paths.`],
  ex: r`A customer-statement endpoint with lazy loading issued 1,201 queries per call (orders, then lines, then products). In the cloud region p95 was 6.4 s. A single projection query brought it to 70 ms, and a command-count test kept it there.`,
  fu: [r`Why is N+1 invisible at compile time and in code review?`, r`When is a loop of explicit loads acceptable?`, r`How does Include of a collection change the row count returned?`],
  pit: [r`"Add Include" without checking for cartesian explosion.`, r`Serializing entities with lazy navigations.`, r`Unit tests with in-memory data that cannot count queries.`] },

{ id: 'q9', level: 'Intermediate', tags: ['ef-core', 'projection', 'include', 'read-models'],
  q: r`Include vs projection: which is your default for read models, and how do you project child collections, aggregates and computed fields efficiently?`,
  a: r`### Include
Loads **entire entities**: every column (including large ones), every related row, tracked and snapshotted unless you say otherwise, and principal columns repeated on every child row. Use it when you will **modify** the graph.

### Projection ({{Select}} into a DTO)
- Fetches **only the needed columns**, so a covering index can satisfy the query.
- Aggregates run in SQL ({{o.Lines.Count}}, {{Sum}}) instead of loading children.
- **Untracked** by construction.
- Shapes the API contract explicitly, so adding a column to an entity does not leak into responses.

### Child collections in a projection
{{Lines = o.Lines.OrderBy(...).Select(...).Take(10).ToList()}} translates to a join or {{OUTER APPLY}}. With several collection projections, apply {{AsSplitQuery()}} to avoid cartesian explosion.

### Computed fields
Translatable expressions (arithmetic, {{CASE}} via ternary, date parts) run in SQL; formatting can stay as a client-side call **only in the final projection**. Prefer DTO constructors or records so the shape is compile-checked.

### Reuse
Share projections as {{Expression<Func<Order, OrderDto>>}} fields, or use a mapping library that produces expression trees ({{ProjectTo}}); never map after {{ToList()}}, which loads full entities first.

### Index alignment
A projection lets the query be **index-only**: if the projection needs a column not in the index's key or {{INCLUDE}} list, SQL Server adds key lookups. Design read indexes with the projection in mind.`,
  code: r`~~~csharp
public sealed record StatementDto(Guid AccountId, string Iban, decimal Balance, IReadOnlyList<TxnDto> Recent, int TxnCount);
public sealed record TxnDto(long Id, decimal Amount, string Description, DateTime BookedUtc);

// One round trip, only needed columns, aggregates in SQL, untracked
var statement = await db.Accounts
    .Where(a => a.Id == accountId)
    .Select(a => new StatementDto(
        a.Id, a.Iban, a.Balance,
        a.Transactions.Where(t => t.BookedUtc >= from)
                      .OrderByDescending(t => t.BookedUtc).ThenByDescending(t => t.Id)
                      .Select(t => new TxnDto(t.Id, t.Amount, t.Description, t.BookedUtc))
                      .Take(100).ToList(),
        a.Transactions.Count(t => t.BookedUtc >= from)))
    .SingleOrDefaultAsync(ct);

// Reusable projection expression (composes into SQL)
public static readonly Expression<Func<Order, OrderSummaryDto>> ToSummary =
    o => new OrderSummaryDto(o.Id, o.Customer.Name, o.Lines.Count, o.Lines.Sum(l => l.Qty * l.UnitPrice));
var page = await db.Orders.Where(o => o.Status == OrderStatus.Open).Select(ToSummary).Take(50).ToListAsync(ct);

// Anti-pattern: load full graph, then map in memory
var bad = (await db.Orders.Include(o => o.Lines).Include(o => o.Customer).ToListAsync(ct)).Select(Map).ToList();
~~~`,
  pts: [r`Include loads whole tracked entities; use it to modify graphs.`, r`Projection fetches only needed columns, aggregates in SQL, never tracked.`, r`Collection projections become joins or OUTER APPLY; split when several.`, r`Share projections as expression trees; never map after ToList.`, r`Projection-shaped indexes give index-only plans.`],
  ex: r`An orders API used Include for list pages and returned entities serialized directly; adding a 200 KB PDF column to Order made the list endpoint move 20 MB per page. Moving to DTO projections cut payloads to 40 KB and stopped schema changes leaking into the API.`,
  fu: [r`How do you test that a projection still translates after a refactor?`, r`When does a projection prevent an index-only plan?`, r`How does AutoMapper ProjectTo differ from Map after ToList?`],
  pit: [r`Include for every read.`, r`Projecting after materialisation.`, r`Returning entities from APIs.`] },

{ id: 'q10', level: 'Intermediate', tags: ['ef-core', 'split-queries', 'cartesian-explosion'],
  q: r`Include(o => o.Lines).Include(o => o.Payments) is slow and memory-hungry. Explain cartesian explosion, single vs split queries, their trade-offs, and what changed in EF Core 10.`,
  a: r`### Cartesian explosion
Two **sibling** collection includes are joined in one SQL statement, so the database returns the **cross product**: an order with 20 lines and 10 payments returns **200 rows** for one order; a third sibling of 5 makes it 1,000. Nested includes ({{Lines → Product}}) do not explode the same way, but a single collection include still **duplicates the principal columns** on every child row (painful when the principal has a large column).

### AsSplitQuery
{{AsSplitQuery()}} (or a context default via {{UseQuerySplittingBehavior}}) issues **one query per collection**: orders, then lines for those orders, then payments.

| | Single query | Split query |
|---|---|---|
| Round trips | 1 | 1 + collections |
| Rows transferred | product of collections | sum of collections |
| Consistency | one snapshot | **no consistency** across statements unless in a snapshot/serializable transaction |
| Buffering | streamable | earlier results buffered (unless MARS, which disables savepoints) |
| Paging | fine | {{Skip/Take}} needs a **unique total ordering**; EF 10 fixed the subquery ordering issue |

### Policy
- EF logs {{MultipleCollectionIncludeWarning}} when you include several collections without choosing; promote it to an **error** so every case is decided.
- Prefer **projection** for reads (only needed columns, aggregates instead of child rows).
- Use split queries for write paths that need full graphs, and wrap them in a snapshot transaction when consistency between parent and children matters (balances vs their entries).`,
  code: r`~~~csharp
// 1 order x 20 lines x 10 payments = 200 rows in one result set
var order = await db.Orders.Include(o => o.Lines).Include(o => o.Payments)
    .SingleAsync(o => o.Id == id, ct);

// Split: 3 queries, 1 + 20 + 10 rows
var orderSplit = await db.Orders.Include(o => o.Lines).Include(o => o.Payments)
    .AsSplitQuery()
    .SingleAsync(o => o.Id == id, ct);

// Consistency across the split statements when it matters
await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.Snapshot, ct))
{
    var acct = await db.Accounts.Include(a => a.Entries).Include(a => a.Holds)
        .AsSplitQuery().SingleAsync(a => a.Id == accountId, ct);
    await tx.CommitAsync(ct);
}

// Make the choice mandatory
options.UseSqlServer(cs, sql => sql.UseQuerySplittingBehavior(QuerySplittingBehavior.SingleQuery))
       .ConfigureWarnings(w => w.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
~~~`,
  pts: [r`Sibling collection includes multiply rows; nested ones duplicate principals.`, r`AsSplitQuery trades rows for round trips.`, r`Split queries are not consistent without a snapshot or serializable transaction.`, r`Paged split queries need a unique ordering (EF 10 fixed the subquery case).`, r`Make MultipleCollectionIncludeWarning an error; prefer projection for reads.`],
  ex: r`A loan-servicing screen included schedule, payments and fees: 360 x 120 x 40 = 1.7 million rows per loan, 2 GB of transfer and an out-of-memory crash. Split queries returned 521 rows; the read path later moved to projection.`,
  fu: [r`Why do one-to-one navigations stay joined even in split mode?`, r`What does MARS do to split queries and to savepoints?`, r`How would you load 1,000 orders with lines and payments for a batch job?`],
  pit: [r`Split everywhere by default without thinking about consistency.`, r`Non-unique ordering with Skip/Take on split queries before EF 10.`, r`Leaving the warning as a warning.`] },

{ id: 'q11', level: 'Intermediate', tags: ['ef-core', 'pagination', 'keyset'],
  q: r`Skip((page - 1) * 50).Take(50) on a 400-million-row transactions table: what goes wrong, and how do you implement keyset pagination in EF Core with stable cursors?`,
  a: r`### Offset pagination
{{OFFSET n ROWS}} still **reads and discards** n rows: O(offset + k). Page 50,000 walks about 2.5 million index rows to return 50. Under concurrent inserts, rows **shift** between pages: users see duplicates or miss items. A {{Count()}} for "page x of y" on every request adds another scan.

### Keyset (seek) pagination
Remember the last row's sort key and seek past it:
{{WHERE (BookedUtc < @c OR (BookedUtc = @c AND Id < @id)) ORDER BY BookedUtc DESC, Id DESC}}
- O(log N + k) with an index on {{(AccountId, BookedUtc DESC, Id DESC)}}.
- Stable under inserts.
- **Unique, total ordering** is mandatory: add the primary key as a tiebreaker.
- Fetch **k + 1** rows to know whether a next page exists without counting.

### Cursor design
- Opaque to clients: base64 of the last key values, plus direction and a version, **signed (HMAC)** so it cannot be tampered with to read other accounts' data.
- Previous page: reverse the comparison and ordering, then reverse the results.
- On SQL Server prefer {{datetime2}} plus {{bigint}} as the tiebreaker over a GUID (SQL Server sorts uniqueidentifier differently from .NET).

### Trade-off
No random "jump to page 4,812". Offer filters (date range) instead. Keep offset for small admin lists; for exports use keyset chunks.`,
  code: r`~~~csharp
public sealed record Cursor(DateTime BookedUtc, long Id);

public async Task<Page<TxnDto>> GetPageAsync(Guid accountId, Cursor? after, int size, CancellationToken ct)
{
    var q = db.Transactions.AsNoTracking().Where(t => t.AccountId == accountId);
    if (after is not null)
        q = q.Where(t => t.BookedUtc < after.BookedUtc || (t.BookedUtc == after.BookedUtc && t.Id < after.Id));

    var rows = await q.OrderByDescending(t => t.BookedUtc).ThenByDescending(t => t.Id)
        .Take(size + 1)                                              // one extra = "has more"
        .Select(t => new TxnDto(t.Id, t.Amount, t.Description, t.BookedUtc))
        .ToListAsync(ct);

    var hasMore = rows.Count > size;
    if (hasMore) rows.RemoveAt(rows.Count - 1);
    var next = hasMore ? cursorCodec.Encode(new Cursor(rows[^1].BookedUtc, rows[^1].Id)) : null;   // HMAC-signed, opaque
    return new Page<TxnDto>(rows, next);
}

// Supporting index (migration)
migrationBuilder.Sql("CREATE INDEX IX_Txn_Account_Booked ON dbo.Transactions (AccountId, BookedUtc DESC, Id DESC) INCLUDE (Amount, Description);");
~~~`,
  pts: [r`Offset is O(offset + k) and unstable under inserts.`, r`Keyset seeks past the last key: O(log N + k), stable.`, r`Unique total ordering with a tiebreaker; index matches filter and order.`, r`Fetch k + 1 instead of counting; signed opaque cursors.`, r`No random page jumps: offer filters instead.`],
  ex: r`A banking app's transaction history timed out for business customers with 2 million transactions per year because deep pages used OFFSET. Keyset pagination with a matching index gave constant 15 ms pages and fixed duplicate rows reported after new transactions arrived mid-scroll.`,
  fu: [r`How do you implement "previous page" with keyset?`, r`How do you paginate when the user can sort by amount?`, r`Why is a GUID a poor tiebreaker on SQL Server?`],
  pit: [r`Sort key without a unique tiebreaker.`, r`COUNT(*) on every page.`, r`Unsigned cursors that expose or allow tampering with keys.`] },

{ id: 'q12', level: 'Intermediate', tags: ['ef-core', 'raw-sql', 'stored-procedures', 'security'],
  q: r`When do you drop to raw SQL in EF Core, and how do you keep it injection-safe and composable? Cover FromSql vs FromSqlRaw, SqlQuery, ExecuteSql, keyless entities and stored procedures.`,
  a: r`### APIs
| API | Use |
|---|---|
| {{FromSql($"...{x}")}} | entity query from SQL; the interpolated string is a {{FormattableString}}, so every hole becomes a **parameter** |
| {{FromSqlRaw(sql, params)}} | when you must build the SQL text; **never concatenate input** into it |
| {{Database.SqlQuery<T>($"...")}} | scalars or unmapped types (EF 8+); composable |
| {{Database.ExecuteSql($"...")}} | DML / procedure calls returning rows affected |
| Keyless entity ({{HasNoKey}}, {{ToView}}) | read-only shapes from views or functions; never tracked |

### Composability
EF wraps your SQL as a subquery, so {{Where}}, {{OrderBy}}, {{Include}} can follow **only if** the SQL is a single SELECT (no trailing semicolon, no ORDER BY on SQL Server without TOP). **Stored procedures** ({{EXEC ...}}) cannot be wrapped: call {{AsEnumerable()}} or {{ToListAsync}} right after.

### Injection
Interpolated APIs are safe. The classic bug is {{FromSqlRaw($"... {input}")}}: interpolation into the **Raw** method concatenates. EF 10 adds an analyzer warning; treat it as an error. **Identifiers** (sort column, table) cannot be parameters: allow-list them.

### What raw SQL bypasses
Global query filters apply to {{FromSql}} results only when composable; {{ExecuteSql}} and Dapper bypass **tenant and soft-delete filters** and SaveChanges interceptors entirely.

### Legitimate uses
Locking hints ({{UPDLOCK, READPAST}} for queue claims), window functions and CTEs that LINQ expresses badly, MERGE and bulk operations, calling existing procedures. Keep them in one place, tagged, and tested against the real engine.`,
  code: r`~~~csharp
// Safe: interpolation becomes parameters
var status = "Pending";
var claimed = await db.Payments
    .FromSql($"SELECT TOP (100) * FROM dbo.Payments WITH (UPDLOCK, READPAST, ROWLOCK) WHERE Status = {status}")
    .AsNoTracking()
    .ToListAsync(ct);

// Composable: SQL becomes a subquery, LINQ continues in SQL
var big = await db.Payments.FromSql($"SELECT * FROM dbo.Payments WHERE MerchantId = {merchantId}")
    .Where(p => p.Amount.Amount > 10_000).OrderByDescending(p => p.CreatedUtc).Take(20).ToListAsync(ct);

// Unmapped result type (EF 8+)
var totals = await db.Database
    .SqlQuery<MerchantTotal>($"SELECT MerchantId, SUM(Amount) AS Total FROM dbo.Payments WHERE CreatedUtc >= {from} GROUP BY MerchantId")
    .ToListAsync(ct);

// Stored procedure: not composable, materialise first
var rows = (await db.Statements.FromSql($"EXEC dbo.Statement_Get @AccountId = {accountId}").ToListAsync(ct))
           .Where(s => s.Amount != 0).ToList();

// Set-based DML
var affected = await db.Database.ExecuteSql($"UPDATE dbo.Holds SET Status = 'Expired' WHERE ExpiresUtc < {DateTime.UtcNow}");

// INJECTABLE: interpolation into Raw concatenates
// db.Customers.FromSqlRaw($"SELECT * FROM dbo.Customers WHERE Name = '{name}'");

// Identifier: allow-list, never a parameter
var sortCol = sort switch { "date" => "CreatedUtc", "amount" => "Amount", _ => "Id" };
~~~`,
  pts: [r`FromSql, SqlQuery and ExecuteSql with interpolation are parameterised.`, r`FromSqlRaw with interpolated or concatenated input is injectable.`, r`Composable only for single SELECTs; procedures must be materialised first.`, r`Raw SQL bypasses filters and interceptors: tenant isolation must not rely on them.`, r`Allow-list identifiers; tag and test raw SQL on the real engine.`],
  ex: r`A search feature used FromSqlRaw($"... LIKE '%{term}%'") and was exploitable; a penetration test exfiltrated customer emails. The fix moved to FromSql with EF.Functions.Like, and a build rule now fails on FromSqlRaw with an interpolated string.`,
  fu: [r`Why do global query filters not protect ExecuteSql?`, r`How do you map a table-valued function for composable queries?`, r`How do you share one transaction between EF and Dapper?`],
  pit: [r`FromSqlRaw with $ interpolation.`, r`Composing LINQ over EXEC.`, r`Assuming tenant filters apply to raw DML.`] },

{ id: 'q13', level: 'Intermediate', tags: ['ef-core', 'savechanges', 'interceptors'],
  q: r`What exactly does SaveChanges do (ordering, batching, transaction, generated values), and what state is the context in after it fails?`,
  a: r`### The steps
1. **DetectChanges**: compare each tracked entity's current values with its snapshot.
2. **SavingChanges interceptors** run: audit stamping, soft-delete conversion, tenant validation, outbox rows. Anything they add is saved in the same transaction.
3. **Topological sort** by foreign keys: principals inserted before dependents; dependents deleted before principals.
4. **Batching**: statements grouped into few round trips (SQL Server default max batch size 42; the 2,100-parameter limit also caps batches). Store-generated values (identity, rowversion, defaults) are read back with {{OUTPUT}}, which is illegal on tables with triggers unless you declare {{HasTrigger}}.
5. **One transaction** unless one already exists: either everything succeeds or nothing is written. {{AutoTransactionBehavior.WhenNeeded}} skips it when only one statement runs.
6. **Accept changes**: Added and Modified become Unchanged, Deleted entities are detached, generated keys are propagated to dependents.

### After a failure
- {{DbUpdateException}} (constraint, FK, unique) or {{DbUpdateConcurrencyException}} (0 rows matched a concurrency token).
- The database transaction is rolled back, but the **change tracker still holds the pending changes**: calling SaveChanges again resends everything, including whatever caused the error.
- Correct responses: fix the specific entry and retry, or {{ChangeTracker.Clear()}} / dispose and redo the unit of work from the start (needed for execution-strategy retries).
- Identify unique violations by **provider error number** (SQL Server 2627 / 2601, PostgreSQL 23505), not by message text.

### acceptAllChangesOnSuccess: false
Keeps entries in their pending states after a successful save, so a surrounding transaction can retry the whole unit and then call {{AcceptAllChanges()}}.`,
  code: r`~~~csharp
public sealed class AuditInterceptor(TimeProvider clock, ICurrentUser user) : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData e, InterceptionResult<int> result, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        foreach (var entry in e.Context!.ChangeTracker.Entries<IAuditable>())
        {
            if (entry.State == EntityState.Added) { entry.Entity.CreatedUtc = now; entry.Entity.CreatedBy = user.Id; }
            if (entry.State is EntityState.Added or EntityState.Modified) { entry.Entity.ModifiedUtc = now; entry.Entity.ModifiedBy = user.Id; }
        }
        return base.SavingChangesAsync(e, result, ct);
    }
}

try
{
    db.Payments.Add(payment);
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2627 or 2601 })
{
    db.ChangeTracker.Clear();                                         // do not resend the failed insert
    var existing = await db.Payments.AsNoTracking()
        .SingleAsync(p => p.IdempotencyKey == payment.IdempotencyKey, ct);
    return Results.Ok(existing.ToDto());                              // duplicate request: replay
}

// Batch size and triggers
options.UseSqlServer(cs, sql => sql.MaxBatchSize(100));
modelBuilder.Entity<Account>().ToTable(t => t.HasTrigger("trg_Accounts_Audit"));
~~~`,
  pts: [r`DetectChanges → interceptors → FK ordering → batching with OUTPUT → one transaction → accept changes.`, r`Interceptors add audit and outbox rows atomically.`, r`After failure the tracker still holds pending changes: fix or clear before retrying.`, r`Detect duplicates by error number, not message.`, r`Triggers require HasTrigger because OUTPUT without INTO fails.`],
  ex: r`A retry loop around SaveChanges kept failing with the same unique violation because the failed insert stayed in the tracker; it also re-sent a valid update three times. Clearing the tracker and treating 2627 as "already processed" fixed both.`,
  fu: [r`What does AutoTransactionBehavior.Never risk?`, r`How does EF order inserts when two new entities reference each other?`, r`Why might SaveChanges issue more round trips than you expect?`],
  pit: [r`Retrying SaveChanges on the same dirty context.`, r`Parsing exception messages to detect duplicates.`, r`Interceptors that do I/O (HTTP calls) inside SaveChanges.`] },

{ id: 'q14', level: 'Intermediate', tags: ['ef-core', 'disconnected-entities', 'api', 'security'],
  q: r`An API receives an updated aggregate as JSON. Compare Add, Attach, Update and Remove, explain the client-generated-key trap and over-posting, and show how you persist an update safely.`,
  a: r`### What each call does to entity state
| Call | Root and graph state | SQL on SaveChanges |
|---|---|---|
| {{Add}} | all Added | INSERT for everything |
| {{Attach}} | key set → Unchanged; no key → Added | nothing until you change properties |
| {{Update}} | key set → **all properties Modified**; no key → Added | UPDATE **every column** |
| {{Remove}} | Deleted | DELETE |

### Why Update(dto.ToEntity()) is dangerous
- It **overwrites every column**, including ones the client never sent (they become null or default): lost updates.
- **Over-posting / mass assignment**: binding the request straight to an entity lets a client set {{IsAdmin}}, {{Balance}} or {{TenantId}}.
- No business rules run: the aggregate's invariants are bypassed.

### The client-generated-key trap
{{Guid}} keys are {{ValueGeneratedOnAdd}} by convention. If the client generates the key, {{Update(graph)}} sees a key and assumes the row exists: a *new* child becomes {{UPDATE ... WHERE Id = @id}}, which matches 0 rows and throws {{DbUpdateConcurrencyException}}, an "insert failed" disguised as a concurrency error. Use {{Add}} for creates, or configure {{ValueGeneratedNever()}} and set states explicitly.

### The safe update
1. **Load** the aggregate (tracked), scoped by tenant and owner.
2. Check the client's **concurrency token** (ETag / If-Match) against the loaded rowversion.
3. Apply changes through **domain methods**, or copy an explicit allow-list of fields.
4. {{SaveChanges}}: the tracker emits a **minimal UPDATE** of only the changed columns, guarded by the token.

For mixed graphs (new, changed and removed children), diff the incoming children against the loaded collection explicitly, or use {{TrackGraph}} with per-node state decisions.`,
  code: r`~~~csharp
// Unsafe: overwrites everything, trusts client fields, no rules
// db.Update(request.ToEntity()); await db.SaveChangesAsync(ct);

app.MapPut("/accounts/{id:guid}/limits", async (Guid id, UpdateLimitsRequest req, HttpRequest http,
                                                PaymentsDbContext db, ITenant tenant, CancellationToken ct) =>
{
    var account = await db.Accounts.SingleOrDefaultAsync(a => a.Id == id && a.TenantId == tenant.Id, ct);
    if (account is null) return Results.NotFound();

    // Optimistic concurrency from the ETag the client last saw
    var etag = Convert.FromBase64String(http.Headers.IfMatch.ToString().Trim('"'));
    db.Entry(account).Property(a => a.RowVersion).OriginalValue = etag;

    account.ChangeLimits(req.DailyLimit, req.SingleTxnLimit, changedBy: http.HttpContext.User.Identity!.Name!);  // rules live here

    try { await db.SaveChangesAsync(ct); }
    catch (DbUpdateConcurrencyException) { return Results.StatusCode(StatusCodes.Status412PreconditionFailed); }
    return Results.NoContent();
});

// Child collection diff for a mixed graph
var incoming = req.Beneficiaries.ToDictionary(b => b.Id);
foreach (var existing in customer.Beneficiaries.ToList())
    if (!incoming.ContainsKey(existing.Id)) customer.RemoveBeneficiary(existing.Id);
foreach (var b in req.Beneficiaries)
    if (customer.Beneficiaries.All(x => x.Id != b.Id)) customer.AddBeneficiary(b.Id, b.Iban, b.Name);
    else customer.UpdateBeneficiary(b.Id, b.Name);
~~~`,
  pts: [r`Update marks every property Modified and overwrites all columns.`, r`Binding requests to entities enables over-posting.`, r`Client-generated keys make Update treat new rows as existing: 0-row "concurrency" errors.`, r`Load, check the ETag, apply domain methods, save a minimal UPDATE.`, r`Diff child collections explicitly or use TrackGraph.`],
  ex: r`A profile endpoint called db.Update on the posted DTO; mobile clients that did not send the marketing-consent field reset it to false for 80,000 customers, a GDPR incident. Load-then-modify with an allow-listed field set fixed it.`,
  fu: [r`How does the rowversion reach the client and come back?`, r`What does setting entry.State = Modified do?`, r`How would you handle a deleted child in the payload?`],
  pit: [r`Update() for every write.`, r`Trusting TenantId or OwnerId from the request body.`, r`Treating a 0-row update on a new entity as a concurrency conflict.`] },

{ id: 'q15', level: 'Intermediate', tags: ['ef-core', 'concurrency', 'rowversion'],
  q: r`Two users edit the same trade. Explain optimistic concurrency in EF Core: tokens, the three value sets, resolution policies, and what a token cannot protect.`,
  a: r`### Mechanism
Configure a **concurrency token**:
- {{IsRowVersion()}} / {{[Timestamp]}} on SQL Server: a {{rowversion}} column the database changes on every update.
- {{IsConcurrencyToken()}} / {{[ConcurrencyCheck]}}: an app-managed value (a version number or GUID). PostgreSQL commonly maps the {{xmin}} system column.

EF adds the token's **original value** to the WHERE clause: {{UPDATE Trades SET ... WHERE Id = @id AND RowVersion = @orig}}. Zero rows affected throws {{DbUpdateConcurrencyException}} (also for a concurrent delete). An insert collision is a **unique violation**, not a concurrency exception.

### Three value sets
**Current** (what you set), **original** (what you loaded), **database** ({{GetDatabaseValuesAsync}}). To retry, refresh the originals from the database values and re-apply.

### Resolution policies
| Policy | Use |
|---|---|
| Fail to the caller (409 / **412** with ETag) | human edits: show the newer version |
| Database wins | caches, derived data |
| Client wins | rarely; last-writer-wins by decision |
| Merge disjoint fields | forms where users edit different fields |
| **Retry the whole unit**, re-evaluating the rule | automated processes |

Retrying only the save without re-reading and re-checking the business rule is a bug: the rule was evaluated on stale data.

### What a token cannot see
- Cross-row invariants (total exposure across several trades).
- Writes from {{ExecuteUpdate}} / {{ExecuteDelete}} and raw SQL, unless you include the token in their predicates.
- **Hot rows**: under contention retries amplify load into a retry storm; use atomic conditional updates or redesign (ledger, sharded counters).`,
  code: r`~~~csharp
modelBuilder.Entity<Trade>().Property(t => t.RowVersion).IsRowVersion();

// Automated process: retry the unit, re-evaluating the rule on fresh data
for (var attempt = 1; ; attempt++)
{
    await using var db = await factory.CreateDbContextAsync(ct);
    var trade = await db.Trades.SingleAsync(t => t.Id == tradeId, ct);
    if (!trade.CanAmend(newQty)) return AmendResult.Rejected;          // rule checked on current data
    trade.Amend(newQty, newPrice);
    try { await db.SaveChangesAsync(ct); return AmendResult.Ok; }
    catch (DbUpdateConcurrencyException) when (attempt < 3)
    {
        await Task.Delay(Random.Shared.Next(20, 80) * attempt, ct);    // jittered backoff, fresh context next loop
    }
}

// Merge disjoint fields for a human edit
catch (DbUpdateConcurrencyException ex)
{
    var entry = ex.Entries.Single();
    var dbValues = await entry.GetDatabaseValuesAsync(ct);
    if (dbValues is null) return Results.NotFound();                        // deleted meanwhile
    foreach (var p in entry.Properties.Where(p => !p.IsModified))
        p.CurrentValue = dbValues[p.Metadata];                               // take their changes where we did not edit
    entry.OriginalValues.SetValues(dbValues);                              // new baseline token
    await context.SaveChangesAsync(ct);
}
~~~`,
  pts: [r`rowversion or app-managed token in the WHERE clause; 0 rows → DbUpdateConcurrencyException.`, r`Current, original and database values drive resolution.`, r`Humans get 412 / 409; automated work retries the whole unit with the rule re-checked.`, r`Tokens do not cover cross-row invariants, ExecuteUpdate or raw SQL.`, r`Hot rows turn optimistic retries into retry storms.`],
  ex: r`Two operations staff amended the same FX trade; the second save silently overwrote the first's settlement instructions because the table had no token. After adding rowversion and returning 412 with the current version, the UI showed a diff and the conflict was resolved by the user.`,
  fu: [r`How do you map If-Match / ETag to the rowversion?`, r`Why is a concurrency exception not thrown for duplicate inserts?`, r`What metric shows optimistic-concurrency contention in production?`],
  pit: [r`Catching the exception and blindly saving again.`, r`Retrying the save without re-checking the business rule.`, r`Assuming a token protects ExecuteUpdate.`] },

{ id: 'q16', level: 'Intermediate', tags: ['ef-core', 'executeupdate', 'bulk', 'change-tracking'],
  q: r`A job rewritten with ExecuteUpdate went from 41 minutes to 3 seconds, and then fees silently stopped being charged. What are ExecuteUpdate and ExecuteDelete, and which guarantees did the rewrite lose?`,
  a: r`{{ExecuteUpdateAsync}} and {{ExecuteDeleteAsync}} (EF 7+) translate a LINQ query into **one set-based UPDATE or DELETE** and run it **immediately**: no loading, no tracking, no per-row statements. That is the 41-minutes-to-3-seconds win.

### What they do not do
1. **The change tracker is unaware.** A tracked entity keeps its old snapshot; a later {{SaveChanges}} that touches *any* property of it writes its **stale value back**, silently overwriting the set-based change (balance 5, ExecuteUpdate makes it 6, tracked entity adds 2 to its stale 5 and writes 7). That is the fee incident.
2. **No implicit transaction across calls**: each call commits on its own. Wrap several in an explicit transaction if they must be atomic.
3. **No concurrency-token check** unless you put the token in the predicate; check **rows affected** yourself.
4. **No SaveChanges interceptors**: audit stamping, soft delete and outbox rows do not happen. {{ExecuteDelete}} is a **real** delete even if your soft-delete interceptor would have converted it.
5. **No batching** with other changes; no navigations in {{SetProperty}} (project values first).
6. Update and delete only; there is no ExecuteInsert.

### Rules
- Never mix tracked writes and ExecuteUpdate **on the same rows in the same context**: use a fresh context, {{ChangeTracker.Clear()}}, or no-tracking reads.
- Use the rows-affected count as the business outcome (atomic conditional debit: 1 = done, 0 = insufficient funds).
- Add audit explicitly (an {{OUTPUT}} into an audit table via raw SQL, or temporal tables) when bypassing interceptors.
- EF 10 accepts a regular lambda for conditional {{SetProperty}} calls and supports JSON complex-type properties.`,
  code: r`~~~csharp
// Atomic conditional debit: no read, no lost update, outcome from rows affected
var debited = await db.Accounts
    .Where(a => a.Id == accountId && a.Balance >= amount)
    .ExecuteUpdateAsync(s => s
        .SetProperty(a => a.Balance, a => a.Balance - amount)
        .SetProperty(a => a.ModifiedUtc, DateTime.UtcNow), ct);
if (debited == 0) return DebitResult.InsufficientFunds;

// The stale-overwrite bug
var acct = await db.Accounts.SingleAsync(a => a.Id == accountId, ct);      // tracked, FeesDue = 5
await db.Accounts.Where(a => a.Id == accountId)
    .ExecuteUpdateAsync(s => s.SetProperty(a => a.FeesDue, a => a.FeesDue + 1), ct);   // DB: 6
acct.FeesDue += 2;                                                            // tracked: 7 (based on stale 5)
await db.SaveChangesAsync(ct);                                                // writes 7: the +1 is lost

// Several set-based statements, atomically
await using var tx = await db.Database.BeginTransactionAsync(ct);
await db.Holds.Where(h => h.ExpiresUtc < now).ExecuteDeleteAsync(ct);
await db.Accounts.Where(a => a.HoldCount > 0)
    .ExecuteUpdateAsync(s => s.SetProperty(a => a.HoldCount, a => a.Holds.Count()), ct);
await tx.CommitAsync(ct);
~~~`,
  pts: [r`One set-based statement, executed immediately, no tracking.`, r`Tracked entities become stale and can overwrite the change on the next SaveChanges.`, r`No implicit transaction, no token check, no interceptors, ExecuteDelete is a real delete.`, r`Use rows affected as the outcome; wrap multiple calls in a transaction.`, r`Never mix with tracked writes on the same rows in one context.`],
  ex: r`The fee job used ExecuteUpdate to increment FeesDue, while the same context later loaded accounts (tracked before the update) to apply interest and saved them, writing back pre-fee values. A fresh context per phase and a reconciliation check of fees charged vs expected closed the gap; 2.1 million GBP was re-billed.`,
  fu: [r`What test would have caught the stale overwrite?`, r`How do you audit changes made by ExecuteUpdate?`, r`When would you still prefer loading and SaveChanges over ExecuteUpdate?`],
  pit: [r`Assuming "N rows affected" proves correctness.`, r`Soft-delete tables cleaned with ExecuteDelete.`, r`Two ExecuteUpdate calls assumed atomic.`] },

{ id: 'q17', level: 'Intermediate', tags: ['ef-core', 'relationships', 'delete-behavior', 'ddd'],
  q: r`Relationships and delete behaviour: what actually happens on Remove for required and optional relationships, why do some tests pass while production fails, and what is your default for financial data?`,
  a: r`### Basics
The principal holds the key; the dependent holds the foreign key; **required** means the FK is non-nullable. Always declare **explicit FK properties** on dependents (clearer, cheaper updates, no shadow properties).

### Default delete behaviours
| Relationship | Default | Meaning |
|---|---|---|
| Required | {{Cascade}} | EF deletes tracked dependents; the database FK also cascades |
| Optional | {{ClientSetNull}} | EF nulls the FK of **tracked** dependents; the database FK is NO ACTION |
| Explicit | {{Restrict}}, {{NoAction}}, {{SetNull}}, {{ClientCascade}} | |

### The test blind spot
{{ClientSetNull}} and {{ClientCascade}} only touch **dependents that are loaded**. Unit tests load everything, so they pass; in production the children are not loaded, the database rejects the delete (FK violation) or leaves dangling data.

### Orphans
Removing a child from a **required** relationship's collection deletes the child (orphan deletion) when tracked; for an optional relationship it nulls the FK.

### SQL Server specifics
Multiple cascade paths to one table are rejected at migration time; resolve with {{Restrict}} / {{NoAction}}.

### Financial default
**Restrict everywhere**. Never cascade through ledgers, payments or audit data; use **soft delete or supersession** (a new row marks the old one replaced), and archive by policy.

### Shapes
- One-to-one: {{HasForeignKey<TDependent>}} tells EF which side is dependent.
- Many-to-many: skip navigations, or an explicit join entity ({{UsingEntity}}) when the link carries data (role, valid-from).
- **DDD**: navigations **inside** an aggregate; **between aggregates reference by id only**. That keeps the tracker small, prevents accidental Include chains, and makes aggregate boundaries visible in code.`,
  code: r`~~~csharp
public sealed class LedgerEntryConfiguration : IEntityTypeConfiguration<LedgerEntry>
{
    public void Configure(EntityTypeBuilder<LedgerEntry> b)
    {
        b.HasOne<Account>()                         // reference another aggregate by id, no navigation
         .WithMany()
         .HasForeignKey(e => e.AccountId)
         .OnDelete(DeleteBehavior.Restrict);        // never cascade through a ledger

        b.HasOne(e => e.Journal)                    // inside the Journal aggregate: navigation
         .WithMany(j => j.Entries)
         .HasForeignKey(e => e.JournalId)
         .OnDelete(DeleteBehavior.Restrict);
    }
}

// Global policy: no cascades unless explicitly justified
foreach (var fk in modelBuilder.Model.GetEntityTypes().SelectMany(e => e.GetForeignKeys()))
    if (!fk.IsOwnership) fk.DeleteBehavior = DeleteBehavior.Restrict;

// Many-to-many with payload
modelBuilder.Entity<User>().HasMany(u => u.Accounts).WithMany(a => a.Signatories)
    .UsingEntity<AccountSignatory>(j => j.Property(s => s.Role).HasMaxLength(20));

// Orphan deletion: removing from a required collection deletes the row
order.Lines.Remove(line);       // DELETE on SaveChanges (if tracked)
~~~`,
  pts: [r`Required → Cascade, optional → ClientSetNull by default.`, r`Client-side behaviours only affect loaded dependents: tests pass, production fails.`, r`SQL Server rejects multiple cascade paths.`, r`Financial data: Restrict everywhere, soft delete or supersession.`, r`Navigations inside aggregates, ids between them.`],
  ex: r`Deleting a test merchant in UAT cascaded through settlements and ledger entries, erasing six months of reconciliation data. A global Restrict policy and a model-rule test that fails on any cascade made deletions explicit decisions.`,
  fu: [r`How does EF decide which side is dependent in a one-to-one?`, r`What does Remove on a parent do when its children are not loaded?`, r`How would you implement soft delete with unique constraints?`],
  pit: [r`Relying on cascade in financial schemas.`, r`Navigation properties between every aggregate.`, r`Trusting tests that load the whole graph.`] },

{ id: 'q18', level: 'Intermediate', tags: ['ef-core', 'keys', 'identity', 'guid', 'idempotency'],
  q: r`Identity vs HiLo/sequence vs client-generated GUID vs natural key: choose a primary-key strategy for a high-volume, idempotent payments table on SQL Server.`,
  a: r`| Strategy | Strengths | Costs |
|---|---|---|
| {{IDENTITY}} | compact {{bigint}}, ever-increasing clustered index | value known only after insert (EF reads it back via OUTPUT); a blind retry after an ambiguous commit **inserts a second row** |
| **HiLo / sequence** ({{UseHiLo}}, {{HasSequence}}) | EF reserves blocks of ids: keys known before SaveChanges, fewer round trips, batch-friendly | gaps; a sequence object to manage |
| **Client-generated GUID** | key known up front, so a retried insert hits a **duplicate key** instead of duplicating; merges across systems | 16 bytes in every index; random GUIDs fragment a clustered index |
| **Natural key** (IBAN, ISIN, end-to-end id) | meaningful | natural keys get **corrected**; make them unique alternate keys instead |

### The GUID ordering trap
SQL Server sorts {{uniqueidentifier}} by its **last six bytes first**. .NET 9 {{Guid.CreateVersion7()}} is time-ordered in its **leading** bytes, so it does **not** give clustered-index locality on SQL Server (it does on PostgreSQL). Use EF's {{SequentialGuidValueGenerator}} or {{NEWSEQUENTIALID()}}, or cluster on a {{bigint}} and keep the GUID as a non-clustered unique key.

### My choice for payments
- {{bigint}} clustered key from a **sequence / HiLo** (ordering, compact indexes, keyset paging).
- A **client-supplied idempotency key** with a unique index ({{TenantId, IdempotencyKey}}), written in the same transaction: this, not the PK, provides exactly-once.
- A public {{Guid}} id for APIs (no enumeration of sequential ids).
- Multi-tenant shared tables: {{TenantId}} leading every index.

Tables with triggers need {{HasTrigger}} because EF's OUTPUT read-back is illegal on them.`,
  code: r`~~~csharp
modelBuilder.HasSequence<long>("PaymentIds", "dbo").StartsAt(1).IncrementsBy(50);

modelBuilder.Entity<Payment>(b =>
{
    b.HasKey(p => p.Id).IsClustered();
    b.Property(p => p.Id).UseHiLo("PaymentIds", "dbo");             // keys known before SaveChanges, in blocks of 50

    b.Property(p => p.PublicId).HasValueGenerator<SequentialGuidValueGenerator>();
    b.HasIndex(p => p.PublicId).IsUnique();                          // exposed in APIs, non-clustered

    b.Property(p => p.IdempotencyKey).HasMaxLength(64).IsUnicode(false);
    b.HasIndex(p => new { p.TenantId, p.IdempotencyKey }).IsUnique();   // exactly-once guard

    b.HasAlternateKey(p => new { p.TenantId, p.EndToEndId });        // natural key as unique, not as PK
});

// Insert: a retry with the same key fails fast with 2627/2601 and is treated as "already done"
var payment = new Payment(tenantId, request.IdempotencyKey, request.EndToEndId, request.Amount);
db.Payments.Add(payment);
Console.WriteLine(payment.Id);   // already assigned by HiLo, before SaveChanges
await db.SaveChangesAsync(ct);
~~~`,
  pts: [r`IDENTITY is compact but unknown until insert and duplicates on blind retry.`, r`HiLo / sequences give client-known keys in blocks.`, r`SQL Server sorts GUIDs by the last bytes: UUIDv7 is not sequential there.`, r`Natural keys as unique alternate keys, surrogate PKs.`, r`Exactly-once comes from a unique idempotency key, not the PK choice.`],
  ex: r`A card-issuing table clustered on random NEWID() keys ran at 99% fragmentation with page-split latency spikes at month-end. Moving the cluster to a bigint sequence and keeping the GUID as a non-clustered unique key cut insert p99 from 180 ms to 9 ms.`,
  fu: [r`Why is bigint IDENTITY a good fit for ledger entries?`, r`What breaks when a legacy table with an audit trigger is mapped by EF Core 7+?`, r`How do you expose ids publicly without allowing enumeration?`],
  pit: [r`Assuming Guid.CreateVersion7 is sequential on SQL Server.`, r`Natural keys as primary keys.`, r`Relying on the PK alone for idempotency.`] },

{ id: 'q19', level: 'Senior', tags: ['linq', 'performance', 'allocations', 'iterators'],
  q: r`LINQ to Objects in hot paths: where do the allocations and CPU go, what did .NET 8/9 improve, when do you replace LINQ with loops, and how do you write a correct custom operator?`,
  a: r`### Where the cost is
- **Iterator objects** per operator and an **enumerator** per enumeration (heap allocations; interface dispatch per element via {{MoveNext}}/{{Current}}).
- **Closures**: a lambda that captures locals allocates a closure object (and a delegate) per call of the containing method; static lambdas ({{static x => ...}}) cannot capture and avoid it.
- **Boxing** when enumerating a struct enumerator through {{IEnumerable<T>}}.
- **Materialisation**: {{ToList()}} growth copies; {{OrderBy}} buffers and sorts.
- **Hidden multiple enumeration** of an expensive source.

### What the runtime already optimises
.NET 7 to 9 vectorised {{Sum}}, {{Min}}, {{Max}}, {{Average}} on arrays and spans; special-cased {{List<T>}} and arrays ({{Select}} over an array is an array-aware iterator; {{Count()}} uses {{ICollection.Count}}); .NET 9 reduced iterator allocations and added {{CountBy}}, {{AggregateBy}}, {{Index}}. Many "LINQ is slow" claims are outdated: **measure with BenchmarkDotNet** before rewriting.

### When to write a loop
- Per-request hot paths with millions of elements per second, measured as a hotspot.
- Spans and stack data ({{Span<T>}} has no LINQ, by design).
- When you need early exit across several conditions, or to avoid a second pass.
Otherwise LINQ's readability wins.

### Correct custom operators
- Use {{yield return}} but **validate arguments eagerly**: an iterator method's body does not run until the first {{MoveNext}}, so argument exceptions surface far from the call. Split into a public method that validates and a private iterator.
- Dispose correctly: {{foreach}} over the source inside the iterator handles it.
- For {{IQueryable}} sources, a custom operator on {{IEnumerable}} forces client evaluation; write it over {{IQueryable<T>}} by composing existing operators instead.`,
  code: r`~~~csharp
// Allocation-heavy in a hot path: closure + iterators + list growth per call
decimal TotalForCurrency(List<Txn> txns, string ccy) =>
    txns.Where(t => t.Currency == ccy).Select(t => t.Amount).Sum();

// Loop: zero allocations, single pass (only if measured as a hotspot)
decimal TotalForCurrencyFast(List<Txn> txns, string ccy)
{
    decimal sum = 0;
    foreach (var t in CollectionsMarshal.AsSpan(txns))
        if (t.Currency == ccy) sum += t.Amount;
    return sum;
}

// Static lambda: compiler error if it captures, so no hidden closure
var positives = amounts.Where(static a => a > 0m);

// Custom operator: eager validation + lazy iterator
public static class EnumerableExtensions
{
    public static IEnumerable<T[]> Windowed<T>(this IEnumerable<T> source, int size)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        return Iterator(source, size);

        static IEnumerable<T[]> Iterator(IEnumerable<T> source, int size)
        {
            var window = new Queue<T>(size);
            foreach (var item in source)
            {
                window.Enqueue(item);
                if (window.Count > size) window.Dequeue();
                if (window.Count == size) yield return window.ToArray();
            }
        }
    }
}

// Benchmark before deciding
[MemoryDiagnoser]
public class SumBench
{
    private readonly List<Txn> _txns = TestData.Txns(100_000);
    [Benchmark(Baseline = true)] public decimal Linq() => TotalForCurrency(_txns, "EUR");
    [Benchmark] public decimal Loop() => TotalForCurrencyFast(_txns, "EUR");
}
~~~`,
  pts: [r`Costs: iterators, enumerators, closures, boxing, buffering, multiple enumeration.`, r`.NET 7 to 9 vectorised aggregates and specialised arrays and lists: measure before rewriting.`, r`Loops for measured hotspots and spans; LINQ elsewhere.`, r`Static lambdas prevent accidental captures.`, r`Custom iterators: validate eagerly, iterate lazily; compose IQueryable operators for providers.`],
  ex: r`A market-data handler processed 400,000 ticks per second with chained LINQ per tick and spent 30% of CPU in GC. Profiling showed closures and iterator allocations; rewriting two inner methods as span loops removed 1.2 GB/s of allocations, while the rest of the codebase kept LINQ.`,
  fu: [r`Why does a yield-based method not throw ArgumentNullException at the call site?`, r`How does foreach over a List<T> avoid boxing, and when does it box?`, r`What does PLINQ add, and when is it the wrong tool?`],
  pit: [r`Rewriting LINQ to loops everywhere without measurements.`, r`Lazy argument validation in iterator methods.`, r`Custom IEnumerable operators applied to IQueryable sources.`] },

{ id: 'q20', level: 'Senior', tags: ['linq', 'expression-trees', 'dynamic-queries', 'query-cache'],
  q: r`Build a search endpoint with optional filters. How do you compose dynamic predicates (Expression API, PredicateBuilder, specifications) without hurting the EF Core query cache?`,
  a: r`### The simplest correct approach
Compose **conditional Where calls** on the {{IQueryable}}. Each {{Where}} adds an AND; captured variables become parameters. One SQL shape per *combination* of filters, all parameterised, all cacheable.

### When you need OR or runtime-defined rules
Build an {{Expression<Func<T,bool>>}}: combine bodies with {{Expression.OrElse}}/{{AndAlso}}, replacing the second lambda's parameter with the first's (an {{ExpressionVisitor}}). PredicateBuilder-style helpers do this. **Specifications** wrap a named predicate ({{IsOverdue}}) as an expression so it can be reused in queries and in memory ({{Compile()}}).

### The query-cache trap
EF caches compiled queries by **tree shape**. If you embed values with {{Expression.Constant(value)}}, every distinct value is a new shape: **recompilation on every call** and a **different SQL text per value**, which pollutes both EF's cache and SQL Server's plan cache. Microsoft's measurement: about **2.2 times slower and twice the allocation**, and it evicts *other* queries from the cache.

Fix: reference a **closure field** (what the compiler does for captured variables) or {{EF.Parameter(value)}}; use {{EF.Constant}} only deliberately (tiny fixed sets where a per-value plan helps).

### Detection
EF 9+ meter {{Microsoft.EntityFrameworkCore}}: compiled-query cache hits vs misses. A hit rate that never settles near 100% means a dynamic-query defect. In SQL Server: many single-use plans with the same query hash.

### Other dynamic needs
- **Dynamic sort**: map an allow-listed string to a key-selector expression; never accept a raw property path.
- **System.Linq.Dynamic.Core** (string expressions) is convenient for admin tools, but treat inputs as code: allow-list and never expose it to untrusted users.`,
  code: r`~~~csharp
// Conditional composition: parameterised, cache-friendly
IQueryable<Payment> q = db.Payments.AsNoTracking();
if (f.MerchantId is { } m)  q = q.Where(p => p.MerchantId == m);
if (f.MinAmount is { } min) q = q.Where(p => p.Amount.Amount >= min);
if (f.From is { } from)     q = q.Where(p => p.CreatedUtc >= from);
q = f.Sort switch
{
    "amount" => q.OrderByDescending(p => p.Amount.Amount).ThenByDescending(p => p.Id),
    _        => q.OrderByDescending(p => p.CreatedUtc).ThenByDescending(p => p.Id)
};

// OR across runtime-defined rules: combine expression bodies
public static Expression<Func<T, bool>> Or<T>(this Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = a.Parameters[0];
    var right = new ReplaceParameter(b.Parameters[0], p).Visit(b.Body)!;
    return Expression.Lambda<Func<T, bool>>(Expression.OrElse(a.Body, right), p);
}
sealed class ReplaceParameter(ParameterExpression from, ParameterExpression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node) => node == from ? to : node;
}

// Specification reused in SQL and in memory
public static class PaymentSpecs
{
    public static Expression<Func<Payment, bool>> HighRisk(decimal threshold) =>
        p => p.Amount.Amount >= threshold || p.Country == "XX";     // threshold captured: becomes a parameter
}
var risky = await db.Payments.Where(PaymentSpecs.HighRisk(10_000m)
                    .Or(p => p.CardBin.StartsWith("4"))).ToListAsync(ct);

// Cache-polluting: a constant per value (one compile and one SQL text per merchant)
var bad = Expression.Lambda<Func<Payment, bool>>(
    Expression.Equal(Expression.Property(param, "MerchantId"), Expression.Constant(merchantId)), param);
~~~`,
  pts: [r`Conditional Where calls are the default: parameterised and cacheable.`, r`Combine expression bodies with a parameter-replacing visitor for OR logic.`, r`Specifications give reusable named predicates for SQL and memory.`, r`Expression.Constant per value recompiles every call and pollutes plan caches.`, r`Watch compiled-query cache hit rate; allow-list dynamic sort fields.`],
  ex: r`An admin search built predicates with Expression.Constant; SQL Server's plan cache filled with 180,000 single-use plans a day and other queries started recompiling. Switching to captured variables restored a 99.8% EF cache hit rate and cut database CPU by 25%.`,
  fu: [r`Why can compiled queries not help a dynamic search?`, r`How would you implement a rules engine whose rules are stored in the database?`, r`What does EF.Constant do, and when is it the right choice?`],
  pit: [r`String-concatenated predicates or Dynamic LINQ fed by user input.`, r`Expression.Constant for values.`, r`One catch-all predicate with "@p IS NULL OR" for every filter.`] },

{ id: 'q21', level: 'Senior', tags: ['linq', 'ef-core', 'groupby', 'joins', 'translation'],
  q: r`Which LINQ shapes translate well in EF Core and which do not? Cover GroupBy (aggregate vs group materialisation), joins (inner, left, LeftJoin in .NET 10), SelectMany, set operations and window-function needs.`,
  a: r`### GroupBy
- **Aggregate GroupBy** translates to SQL {{GROUP BY}}: {{GroupBy(k).Select(g => new { g.Key, Total = g.Sum(...) })}}.
- **Returning the groups themselves** ({{g.ToList()}}, or iterating {{IGrouping}}) has no SQL equivalent. EF 7+ can translate some top-N-per-group patterns ({{g.OrderBy(...).First()}}) into window functions; otherwise it throws. For "all rows grouped", query ordered rows and group in memory with {{ToLookup}}.

### Joins
- Navigations ({{o.Customer.Name}}) generate joins for you; prefer them to manual {{join}}.
- Manual inner join: {{join ... on ... equals ...}}.
- **Left join**: {{GroupJoin}} + {{SelectMany(... DefaultIfEmpty())}}, or .NET 10 {{LeftJoin}} which EF Core 10 translates directly.
- {{SelectMany}} over a collection navigation: {{INNER JOIN}} or {{CROSS APPLY}}; with {{DefaultIfEmpty}}: {{LEFT JOIN}} / {{OUTER APPLY}}.

### Set operations
{{Union}}, {{Concat}} ({{UNION ALL}}), {{Intersect}}, {{Except}} translate when both sides project the **same shape**. {{Distinct}} after a projection translates; {{DistinctBy}} generally does not.

### Window functions
EF has no general window-function API. {{ROW_NUMBER}}-style top-N per group is produced by some patterns, but running totals, LAG/LEAD and percentiles need **raw SQL** ({{SqlQuery<T>}}), a **view** mapped as keyless, or a mapped table-valued function. Do not force them through LINQ with self-joins.

### Practical rules
1. Write the query, then read {{ToQueryString()}}.
2. If it does not translate cleanly, choose deliberately: reshape, raw SQL, or a view; never an unbounded {{AsEnumerable()}}.
3. Keep reporting queries (window functions, pivots) in SQL where SQL is the artefact.`,
  code: r`~~~csharp
// Aggregate GroupBy: one GROUP BY in SQL
var perMerchant = await db.Payments
    .Where(p => p.CreatedUtc >= from)
    .GroupBy(p => new { p.MerchantId, p.Amount.Currency })
    .Select(g => new { g.Key.MerchantId, g.Key.Currency, Count = g.Count(), Total = g.Sum(p => p.Amount.Amount) })
    .ToListAsync(ct);

// Top-1 per group (translates to ROW_NUMBER in EF 7+)
var latestPerCustomer = await db.Orders
    .GroupBy(o => o.CustomerId)
    .Select(g => g.OrderByDescending(o => o.CreatedUtc).ThenByDescending(o => o.Id).First())
    .ToListAsync(ct);

// Left join (.NET 10 / EF Core 10)
var withLastPayment = await db.Invoices
    .LeftJoin(db.Payments, i => i.Id, p => p.InvoiceId, (i, p) => new { i.Id, i.Amount, PaidUtc = (DateTime?)p!.CreatedUtc })
    .ToListAsync(ct);

// Classic left join for earlier versions
var q = from i in db.Invoices
        join p in db.Payments on i.Id equals p.InvoiceId into gj
        from p in gj.DefaultIfEmpty()
        select new { i.Id, PaidUtc = (DateTime?)p.CreatedUtc };

// Window functions: SQL is the artefact
var running = await db.Database.SqlQuery<RunningBalance>($"""
    SELECT AccountId, BookedUtc, Amount,
           SUM(Amount) OVER (PARTITION BY AccountId ORDER BY BookedUtc, Id ROWS UNBOUNDED PRECEDING) AS Balance
    FROM dbo.LedgerEntries WHERE AccountId = {accountId}
    """).ToListAsync(ct);
~~~`,
  pts: [r`Aggregate GroupBy translates; materialising groups does not.`, r`Top-N per group can translate to ROW_NUMBER; check the SQL.`, r`Left joins via GroupJoin + DefaultIfEmpty, or LeftJoin in EF Core 10.`, r`Set operations need identical projected shapes.`, r`Window functions belong in SqlQuery, views or mapped TVFs.`],
  ex: r`A finance report grouped 30 million ledger rows with GroupBy(...).ToList() after AsEnumerable(), consuming 14 GB in the API pod. Rewriting it as a SQL view with window functions, mapped as a keyless entity, returned 2,000 rows in 3 seconds.`,
  fu: [r`How do you map a SQL view as a keyless entity type?`, r`Why does GroupBy followed by ToList of groups fail translation?`, r`How do you write a LEFT JOIN with a filter on the right side without turning it into an inner join?`],
  pit: [r`AsEnumerable before GroupBy on large tables.`, r`Filtering on the right side of a left join in WHERE, which makes it an inner join.`, r`Forcing running totals through LINQ self-joins.`] },

{ id: 'q22', level: 'Senior', tags: ['ef-core', 'pooling', 'factory', 'di', 'performance'],
  q: r`AddDbContext vs AddDbContextPool vs AddDbContextFactory vs AddPooledDbContextFactory: choose and defend for a high-throughput payments API and its workers, with numbers.`,
  a: r`| Registration | What it is | Use for |
|---|---|---|
| {{AddDbContext}} | scoped, new instance per request | the default |
| {{AddDbContextPool}} | reuses instances (default pool 1,024); EF resets its state on return | profiled hot paths where context setup shows up |
| {{AddDbContextFactory}} | you create and dispose contexts | background workers, Blazor Server, several units of work per scope, parallel work |
| {{AddPooledDbContextFactory}} | a factory over a pool | hot workers |

### What pooling buys
Microsoft's single-row benchmark: about **701.6 to 350.1 µs** and **50 KB to 4.6 KB** allocated per request. But it was single-threaded with a local database. Against a real 5 ms database call, saving 350 µs is about **7%**. Worth it on a CPU-bound API at high RPS; irrelevant on a database-bound one.

### What pooling costs
A pooled context behaves like a **singleton reused across requests**: the **constructor and OnConfiguring run once**. Any per-request state on the context (tenant id, user id, a field read by a query filter) **leaks to the next lease**. EF resets its own state (tracker, options) but not your fields. That is a **cross-tenant data leak**, not a performance bug.

### Decision for the payments API
1. Start with {{AddDbContext}} (scoped).
2. Workers and parallel fan-out use {{IDbContextFactory}}: a context per batch or per task.
3. Adopt pooling only when a profiler shows context creation matters **and** per-request state is injected per lease through a tenant-safe scoped wrapper (and tested).
4. Never mix: a scoped service that needs the request's tracker should not create its own factory context.`,
  code: r`~~~csharp
// API: scoped default
builder.Services.AddDbContext<PaymentsDbContext>(o => o.UseSqlServer(cs));

// Workers: factory, one context per unit of work
builder.Services.AddDbContextFactory<PaymentsDbContext>(o => o.UseSqlServer(cs), ServiceLifetime.Singleton);

// Hot path with pooling AND per-request tenant state set on every lease
builder.Services.AddPooledDbContextFactory<PaymentsDbContext>(o => o.UseSqlServer(cs), poolSize: 512);
builder.Services.AddScoped<TenantScopedFactory>();
builder.Services.AddScoped(sp => sp.GetRequiredService<TenantScopedFactory>().CreateDbContext());

public sealed class TenantScopedFactory(IDbContextFactory<PaymentsDbContext> pool, ITenantAccessor tenant)
    : IDbContextFactory<PaymentsDbContext>
{
    public PaymentsDbContext CreateDbContext()
    {
        var db = pool.CreateDbContext();
        db.TenantId = tenant.TenantId ?? Guid.Empty;     // set on EVERY lease; Guid.Empty fails closed (no rows)
        return db;
    }
}

// Test: the same pooled instance under two tenants must not leak
[Fact]
public async Task Pooled_context_does_not_leak_tenant()
{
    var (sp, pool) = TestHost.WithPoolSize(1);
    using (var s1 = sp.CreateScope()) { TenantAccessor.Set(s1, TenantA); Assert.All(await Read(s1), r => Assert.Equal(TenantA, r.TenantId)); }
    using (var s2 = sp.CreateScope()) { TenantAccessor.Set(s2, TenantB); Assert.All(await Read(s2), r => Assert.Equal(TenantB, r.TenantId)); }
}
~~~`,
  pts: [r`Scoped by default; factory when the unit of work is not the request.`, r`Pooling saves about 350 µs and most allocations per request: single-digit percent on real latency.`, r`Pooled contexts are reused: constructor and OnConfiguring run once.`, r`Per-request state must be set on every lease and fail closed.`, r`Prove it with a pool-size-1 isolation test.`],
  ex: r`A team enabled AddDbContextPool for a 4% throughput gain; the tenant id was set in the context constructor. Under load, a small share of requests ran with the previous lease's tenant and returned another merchant's settlements. Rollback, a lease-time setter, a fail-closed default and RLS in the database followed.`,
  fu: [r`How much of the pooling saving survives a 1 ms database round trip?`, r`Why does EF not reset your custom fields when a context returns to the pool?`, r`When would you choose a transient DbContext registration?`],
  pit: [r`Pooling by default.`, r`Tenant id set in the constructor of a pooled context.`, r`Factory contexts never disposed.`] },

{ id: 'q23', level: 'Senior', tags: ['ef-core', 'background-service', 'workers', 'concurrency'],
  q: r`A BackgroundService must process due settlements every 30 seconds, and the service runs as 4 replicas. Walk through the DbContext lifetime, claiming, failure handling and shutdown.`,
  a: r`### Lifetime
A {{BackgroundService}} is a **singleton**; injecting a scoped {{DbContext}} creates a captive dependency (one context for the life of the process: memory growth, stale identity map, concurrency errors). The **unit of work is the batch**: create a context per iteration from {{IDbContextFactory}} (or a scope via {{IServiceScopeFactory}} when several scoped services must share one tracker and transaction). Enforce {{ValidateScopes}} and {{ValidateOnBuild}} in every environment.

### The bug the fix exposes: replicas
Four replicas run the same loop. Without a **claim** step, two pods pick the same settlement and pay it twice. Claim atomically:
- {{UPDLOCK, READPAST}} via raw SQL inside a short transaction, then mark rows **Claimed** with an owner and lease expiry; or
- a guarded {{ExecuteUpdate}}: {{SET Status = Claimed, Owner = @pod, LeaseUntil = @t WHERE Status = Due AND (LeaseUntil IS NULL OR LeaseUntil < now)}}, then read rows owned by this pod.
Leases make crashed pods' work reclaimable.

### Per-item processing
- Each item in its own unit of work (or small chunk), **idempotent** by business key: a crash after the side effect but before marking done must not double pay.
- **Poison items**: catch per item, record attempts and error, back off, move to a dead-letter status after N tries, alert. One bad row must not stall the loop.
- Bounded parallelism (per the connection budget), one context per worker.

### Timing and shutdown
- {{PeriodicTimer}} (no overlapping ticks) and the host's {{CancellationToken}} passed everywhere.
- On shutdown, finish or abandon the current item cleanly; unfinished claims expire through the lease.
- {{TagWith}} the polling query; emit metrics: items processed, failures, oldest due item age.`,
  code: r`~~~csharp
public sealed class SettlementWorker(IDbContextFactory<PaymentsDbContext> factory, ISettlementGateway gateway,
                                     ILogger<SettlementWorker> log, TimeProvider clock) : BackgroundService
{
    private readonly string _owner = Environment.MachineName;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30), clock);
        while (await timer.WaitForNextTickAsync(stop))
        {
            await using var db = await factory.CreateDbContextAsync(stop);
            var now = clock.GetUtcNow().UtcDateTime;

            // Atomic claim with a lease: safe across replicas
            await db.Settlements.TagWith("Settlement.Claim")
                .Where(s => s.Status == SettlementStatus.Due && (s.LeaseUntil == null || s.LeaseUntil < now))
                .OrderBy(s => s.DueUtc).Take(100)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.Owner, _owner)
                                          .SetProperty(s => s.LeaseUntil, now.AddMinutes(5)), stop);

            var mine = await db.Settlements.AsNoTracking()
                .Where(s => s.Owner == _owner && s.LeaseUntil > now && s.Status == SettlementStatus.Due)
                .Select(s => s.Id).ToListAsync(stop);

            foreach (var id in mine)
            {
                try { await ProcessOneAsync(id, stop); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Settlement {Id} failed", id);
                    await MarkFailedAsync(id, ex, stop);          // attempts++, dead-letter after 5
                }
            }
        }
    }

    private async Task ProcessOneAsync(long id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);   // one unit of work per item
        var s = await db.Settlements.SingleAsync(x => x.Id == id, ct);
        await gateway.PayAsync(s.IdempotencyKey, s.Amount, ct);        // gateway dedupes by key
        s.MarkPaid(clock.GetUtcNow());
        await db.SaveChangesAsync(ct);
    }
}
~~~`,
  pts: [r`Singleton host: context per batch or item from IDbContextFactory; ValidateScopes on.`, r`Replicas need an atomic claim with a lease, not just a query.`, r`Idempotent side effects keyed by business id.`, r`Per-item error handling with attempts and dead-lettering.`, r`PeriodicTimer, cancellation everywhere, metrics on oldest due item.`],
  ex: r`A settlement worker scaled from 1 to 3 replicas paid 214 settlements twice in its first hour because each pod read the same "due" rows. A lease-based claim plus a gateway idempotency key stopped duplicates; the recovered funds took six weeks to chase.`,
  fu: [r`How do you test that two replicas never process the same item?`, r`What symptoms does a captive DbContext show over hours?`, r`Polling vs a queue: when would you switch?`],
  pit: [r`Injecting DbContext into a BackgroundService with scope validation off.`, r`Reading "due" rows without claiming them.`, r`One failing item stopping the whole loop.`] },

{ id: 'q24', level: 'Senior', tags: ['ef-core', 'resilience', 'retries', 'transactions'],
  q: r`What does EnableRetryOnFailure do, what does it cost, why does BeginTransaction throw with it, and how do you combine retries with user transactions safely?`,
  a: r`### Mechanism
{{EnableRetryOnFailure()}} installs an **execution strategy** ({{SqlServerRetryingExecutionStrategy}}) that retries operations failing with **transient** errors: Azure SQL throttling, failover, network blips, a configurable list of error numbers. Defaults: 6 retries, up to 30 seconds delay, randomised exponential backoff. Each query and each {{SaveChanges}} is retried **as a unit**.

### Costs
- Result sets are **buffered** (a retry needs to restart reading), so large queries lose streaming and use more memory.
- Retries add latency and can **amplify a brownout**: a request path should use a tighter budget (for example 3 retries, at most 5 to 10 seconds total) than a batch job.

### User transactions
With retries on, {{BeginTransactionAsync}} followed by several operations throws: "**The configured execution strategy does not support user-initiated transactions**". A retry in the middle could not replay the earlier statements. Fix: wrap the **whole unit** (fresh context state, transaction, all saves, commit) in {{strategy.ExecuteAsync(...)}} so a retry replays it from the start.

### Commit ambiguity
If the connection drops **during COMMIT**, the client cannot know whether the transaction committed. The strategy retries "as if it rolled back"; if it had committed, a store-generated-key insert happens twice. Defences: client-known keys or a unique idempotency key in the same transaction, or {{ExecuteInTransactionAsync}} with a **verifySucceeded** delegate that checks whether the work landed.

### Deadlocks
Whether 1205 (deadlock victim) is treated as transient depends on provider version: check, and add it via {{errorNumbersToAdd}} if your design retries deadlocks.`,
  code: r`~~~csharp
builder.Services.AddDbContext<PaymentsDbContext>(o => o.UseSqlServer(cs, sql =>
    sql.EnableRetryOnFailure(maxRetryCount: 3, maxRetryDelay: TimeSpan.FromSeconds(5), errorNumbersToAdd: [1205])));

// The whole unit inside the strategy: a retry replays from the top
var strategy = db.Database.CreateExecutionStrategy();
await strategy.ExecuteAsync(async () =>
{
    db.ChangeTracker.Clear();                                       // clean state on each attempt
    await using var tx = await db.Database.BeginTransactionAsync(ct);
    var payment = new Payment(request.IdempotencyKey, request.Amount, request.AccountId);
    db.Payments.Add(payment);
    db.Outbox.Add(OutboxMessage.From(new PaymentCreated(payment.PublicId)));
    await db.SaveChangesAsync(ct);
    await tx.CommitAsync(ct);
});

// Commit ambiguity: verify instead of blindly re-inserting
await strategy.ExecuteInTransactionAsync(
    operation: async ct2 =>
    {
        db.Payments.Add(payment);
        await db.SaveChangesAsync(acceptAllChangesOnSuccess: false, ct2);
    },
    verifySucceeded: async ct2 =>
        await db.Payments.AsNoTracking().AnyAsync(p => p.IdempotencyKey == payment.IdempotencyKey, ct2),
    cancellationToken: ct);
db.ChangeTracker.AcceptAllChanges();
~~~`,
  pts: [r`Execution strategy retries transient errors per query and per SaveChanges.`, r`Costs: buffered results, added latency, brownout amplification; tighten budgets on request paths.`, r`User transactions must run inside strategy.ExecuteAsync as one replayable unit.`, r`Commit ambiguity needs idempotency keys or verifySucceeded.`, r`Verify whether deadlock 1205 is retried in your provider version.`],
  ex: r`During an Azure SQL failover a payments API with default retries held requests for up to 90 seconds and the gateway retried them too: 9 times the load arrived when the database came back. Tightened retry budgets on the request path and idempotency keys turned the next failover into 20 seconds of 503s with no duplicates.`,
  fu: [r`Why must the context be reset at the start of each attempt?`, r`What does a retrying strategy do to AsAsyncEnumerable streaming?`, r`How do client-side retries (Polly, gateway) interact with EF retries?`],
  pit: [r`BeginTransaction outside the strategy.`, r`Default retry budgets on latency-sensitive paths.`, r`Store-generated keys with no idempotency key on retried inserts.`] },

{ id: 'q25', level: 'Senior', tags: ['ef-core', 'value-objects', 'complex-types', 'owned-types', 'ddd'],
  q: r`Owned entity types vs complex types (EF 8 to 10): which do you use for value objects like Money and Address, and what changes when you switch?`,
  a: r`### Owned types
Entity types behind the scenes: a **hidden key**, reference semantics, tracked as entities. Consequences: assigning the same instance to two properties ({{Billing = Shipping}}) **throws**; they cannot be used with {{ExecuteUpdate}}; they can contain navigations and can be mapped to a separate table.

### Complex types (EF 8+)
True **value objects**: no identity, compared **by value**, copied on assignment, mapped to the owner's columns. EF 9 and 10 extended them: **struct** complex types, **optional** complex types (EF 10; must contain at least one required property), mapping to **JSON** ({{ToJson}}), **complex collections** (JSON only), and {{ExecuteUpdate}} support. They cannot contain navigations or be a {{DbSet}}, and are **not discovered by convention**: configure them with {{ComplexProperty}}.

### Choosing
| Need | Use |
|---|---|
| Value semantics (Money, Address, DateRange) | complex type |
| Value object holding a navigation | owned type (or redesign) |
| Separate table for the value object | owned type |
| Bulk update of value-object fields | complex type |

**Identity test**: if two customers *sharing* an address should both change when it is edited, it is an **entity**, not a value object.

### Design rules
- Make value objects **immutable records**; change them with {{with}} expressions; EF still tracks per property.
- Put invariants in the constructor (currency code length, non-negative amount).
- Switching owned to complex is a **mapping change**: column names may stay the same, but diff the generated migration and the generated SQL; the tracking semantics change too.
- Do not design around unreleased EF features (complex types on TPT/TPC, indexes on complex-type properties are EF 11 items).`,
  code: r`~~~csharp
public sealed record Money
{
    public decimal Amount { get; }
    public string Currency { get; }
    public Money(decimal amount, string currency)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(amount);
        if (currency is not { Length: 3 }) throw new ArgumentException("ISO 4217 code required", nameof(currency));
        (Amount, Currency) = (amount, currency);
    }
    public Money Add(Money other) => other.Currency == Currency
        ? new Money(Amount + other.Amount, Currency)
        : throw new InvalidOperationException("Currency mismatch");
}

public sealed record Address(string Line1, string? Line2, string City, string PostCode, string CountryCode);

modelBuilder.Entity<Invoice>(b =>
{
    b.ComplexProperty(i => i.Total, m =>
    {
        m.Property(x => x.Amount).HasColumnName("TotalAmount").HasPrecision(19, 4);
        m.Property(x => x.Currency).HasColumnName("TotalCurrency").HasMaxLength(3).IsFixedLength().IsUnicode(false);
    });
    b.ComplexProperty(i => i.BillingAddress);                 // columns BillingAddress_Line1, ...
    b.ComplexProperty(i => i.ShippingAddress);
});

invoice.ShippingAddress = invoice.BillingAddress;              // fine for complex types (value copy); throws for owned types

// Bulk update of a complex-type property (EF 10)
await db.Invoices.Where(i => i.CustomerId == id)
    .ExecuteUpdateAsync(s => s.SetProperty(i => i.BillingAddress, newAddress), ct);
~~~`,
  pts: [r`Owned types are hidden entities with reference semantics.`, r`Complex types are value objects: compared by value, copied, ExecuteUpdate-able.`, r`EF 10 adds optional, struct and JSON complex types and complex collections.`, r`Identity test decides value object vs entity.`, r`Immutable records with invariants; diff migrations when switching mappings.`],
  ex: r`An invoicing service modelled Address as an owned type; copying billing to shipping threw at runtime in production for "same as billing" checkouts. Moving to complex types fixed it and allowed a bulk ExecuteUpdate when a postcode database correction affected 120,000 addresses.`,
  fu: [r`Why must an optional complex type have at least one required property?`, r`How would you store Money as minor units with a currency exponent table?`, r`What happens to the change tracker when you replace a complex-type value with a new record?`],
  pit: [r`Defaulting to owned types for value objects.`, r`Mutable value objects shared between properties.`, r`Assuming a mapping change is a no-op for SQL and tracking.`] },

{ id: 'q26', level: 'Senior', tags: ['ef-core', 'inheritance', 'tph', 'tpt', 'tpc'],
  q: r`PaymentInstrument has subtypes Card, BankAccount and Wallet. TPH, TPT or TPC: how do you choose, and what does each do to queries, constraints and keys?`,
  a: r`| Strategy | Tables | Reads | Integrity | Keys |
|---|---|---|---|---|
| **TPH** (default) | one table + discriminator | fastest; no joins | subtype columns nullable; add a {{CHECK}} per discriminator | any |
| **TPT** ({{UseTptMappingStrategy}}) | base table + one per subtype | **JOIN on every query**; polymorphic queries join all | NOT NULL per subtype | any |
| **TPC** ({{UseTpcMappingStrategy}}, EF 7) | one complete table per concrete type | concrete queries: no joins; polymorphic: {{UNION ALL}} | NOT NULL per type; **no FK can point at the abstract base** | must be unique **across** tables: sequence or GUID |

### The deciding question for instruments
{{Payments.InstrumentId}} needs **one FK target**. TPC cannot give that (there is no base table), so TPC is out. TPT works but every payment lookup joins. **TPH** gives one FK target and fast reads; compensate for nullable subtype columns with **CHECK constraints per discriminator** value.

### Better still: question the inheritance
If subtypes have different lifecycles and rules, model separate aggregates behind an interface, with a small shared {{Instruments}} table for the FK and per-type detail tables or a JSON details column. Inheritance hierarchies are hard to evolve.

### Practicalities
- Query filters apply only to the **root** type.
- {{OfType<Card>()}} filters on the discriminator in TPH; verify the SQL.
- Adding a subtype in TPH is additive (new discriminator value, new nullable columns); in TPT a new table; in TPC a new table and key-range planning.
- PCI: never store a PAN; store a token, last four and expiry.`,
  code: r`~~~csharp
public abstract class PaymentInstrument { public long Id { get; set; } public Guid CustomerId { get; set; } public bool IsActive { get; set; } }
public sealed class Card : PaymentInstrument { public string Token { get; set; } = ""; public string Last4 { get; set; } = ""; public DateOnly Expiry { get; set; } }
public sealed class BankAccount : PaymentInstrument { public string Iban { get; set; } = ""; public string Bic { get; set; } = ""; }
public sealed class Wallet : PaymentInstrument { public string Provider { get; set; } = ""; public string WalletRef { get; set; } = ""; }

modelBuilder.Entity<PaymentInstrument>(b =>
{
    b.ToTable("PaymentInstruments", t =>
    {
        t.HasCheckConstraint("CK_Card_Fields",   "[Kind] <> 'Card' OR ([Token] IS NOT NULL AND [Last4] IS NOT NULL AND [Expiry] IS NOT NULL)");
        t.HasCheckConstraint("CK_Bank_Fields",   "[Kind] <> 'Bank' OR ([Iban] IS NOT NULL AND [Bic] IS NOT NULL)");
        t.HasCheckConstraint("CK_Wallet_Fields", "[Kind] <> 'Wallet' OR ([Provider] IS NOT NULL AND [WalletRef] IS NOT NULL)");
    });
    b.HasDiscriminator<string>("Kind").HasValue<Card>("Card").HasValue<BankAccount>("Bank").HasValue<Wallet>("Wallet");
    b.Property("Kind").HasMaxLength(10).IsUnicode(false);
});
modelBuilder.Entity<Payment>().HasOne<PaymentInstrument>().WithMany().HasForeignKey(p => p.InstrumentId)
    .OnDelete(DeleteBehavior.Restrict);            // one FK target: only possible with TPH or TPT

// TPC alternative (no FK to base possible), keys from a shared sequence
// modelBuilder.Entity<PaymentInstrument>().UseTpcMappingStrategy().Property(i => i.Id).HasDefaultValueSql("NEXT VALUE FOR dbo.InstrumentIds");

var cards = await db.Set<PaymentInstrument>().OfType<Card>().Where(c => c.Expiry < soon).ToListAsync(ct);
~~~`,
  pts: [r`TPH: one table, fastest, nullable subtype columns: add CHECKs per discriminator.`, r`TPT: normalised but joins on every query.`, r`TPC: no joins for concrete queries, UNION ALL for polymorphic, no FK to the base.`, r`A single FK target rules out TPC.`, r`Question whether inheritance is the right model at all.`],
  ex: r`A wallet product used TPT across 7 instrument types; the payment-authorisation query joined 8 tables and took 40 ms at p99. Moving to TPH with CHECK constraints cut it to 3 ms and simplified adding two new instrument types.`,
  fu: [r`How do you verify OfType<Card>() uses the discriminator and not a join?`, r`How would you migrate from TPT to TPH without downtime?`, r`Why must TPC keys be unique across tables?`],
  pit: [r`TPT "because it is normalised".`, r`TPC without noticing the lost FK.`, r`TPH without CHECK constraints.`] },

{ id: 'q27', level: 'Senior', tags: ['ef-core', 'value-converters', 'change-tracking'],
  q: r`A List<string> Flags property is stored through a comma-join value converter, and edits "sometimes vanish". Explain the bug, the fix, and other converter pitfalls (strongly typed ids, enums, encryption).`,
  a: r`### The bug
For a converted **mutable reference type**, EF's default comparison is **reference equality**. {{Flags.Add("PEP")}} mutates the list in place, so the snapshot and the current value are the **same reference**: EF detects **no change**, sends **no UPDATE**, and throws **no exception**. The write "succeeds" and does nothing.

### Fixes
1. A {{ValueComparer<T>}} that compares by content, hashes by content and **snapshots by copying**.
2. Or (EF 8+) map the list as a **primitive collection** (stored as a JSON array, queryable with {{Contains}}) with no custom converter.
3. Or, for data with meaning (sanctions or PEP flags), a **normalised table** ({{CustomerFlags}} with set-by and set-at): indexable, auditable, constrainable.

EF logs {{CoreEventId.CollectionWithoutComparer}} only as a **warning**; promote it to an error.

### Other converter pitfalls
- **Query translation**: comparisons happen on the **provider value**. Ordering an enum stored as string sorts alphabetically; {{Contains}} on a comma-joined column cannot use an index; range filters on encrypted values are impossible.
- **Strongly typed ids** ({{PaymentId}} wrapping a Guid): use converters plus value generators; make them {{readonly record struct}}; check that keys in {{Where}} still translate to parameters.
- **Enums as strings**: readable and safe to reorder; pair with a {{CHECK}} constraint listing the allowed values.
- **Encryption converters**: the column becomes unqueryable except for equality with deterministic encryption; key rotation needs a migration plan.

### Diagnosis
{{ChangeTracker.DebugView.LongView}} shows the property as unchanged; the SQL log shows no UPDATE. Regression test: mutate, save, **reload in a fresh context**, assert.`,
  code: r`~~~csharp
// Bug: in-place mutation not detected
modelBuilder.Entity<Customer>().Property(c => c.Flags)
    .HasConversion(v => string.Join(',', v), s => s.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList());
customer.Flags.Add("PEP");
await db.SaveChangesAsync(ct);   // no UPDATE sent

// Fix 1: value comparer (content equality, content hash, deep snapshot)
var comparer = new ValueComparer<List<string>>(
    (a, b) => a!.SequenceEqual(b!),
    v => v.Aggregate(0, (h, s) => HashCode.Combine(h, s.GetHashCode())),
    v => v.ToList());
modelBuilder.Entity<Customer>().Property(c => c.Flags)
    .HasConversion(v => string.Join(',', v), s => s.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList(), comparer);

// Fix 2 (EF 8+): primitive collection, no converter
modelBuilder.Entity<Customer>().PrimitiveCollection(c => c.Tags);

// Make the warning fatal
options.ConfigureWarnings(w => w.Throw(CoreEventId.CollectionWithoutComparer));

// Strongly typed id
public readonly record struct PaymentId(Guid Value);
modelBuilder.Entity<Payment>().Property(p => p.Id).HasConversion(id => id.Value, v => new PaymentId(v));

// Enum as string + CHECK
modelBuilder.Entity<Payment>().Property(p => p.Status).HasConversion<string>().HasMaxLength(20);
modelBuilder.Entity<Payment>().ToTable(t => t.HasCheckConstraint("CK_Payment_Status",
    "[Status] IN ('Pending','Authorised','Captured','Failed','Refunded')"));

// Regression test: reload in a fresh context
[Fact] public async Task Flag_added_in_place_is_persisted() { /* mutate, save, new context, assert contains */ }
~~~`,
  pts: [r`Mutable converted types use reference equality by default: in-place edits are invisible.`, r`Fix with a ValueComparer, a primitive collection, or a real table.`, r`Promote CollectionWithoutComparer to an error.`, r`Queries compare provider values: enum-string ordering, comma lists, encrypted columns.`, r`Test by mutate, save, reload in a fresh context.`],
  ex: r`A KYC screen added "PEP" to customers' risk flags in place; for six weeks none of those writes reached the database, so enhanced due diligence never triggered for 312 politically exposed customers. The regulator noted it; the fix was a normalised flags table with audit columns.`,
  fu: [r`Write an order-independent hash for a HashSet comparer.`, r`How does a converter affect index usage in WHERE clauses?`, r`How would you rotate the key behind an encryption converter?`],
  pit: [r`Blaming EF without understanding snapshot equality.`, r`Replacing the list as a workaround without a test.`, r`Ignoring the warning in logs.`] },

{ id: 'q28', level: 'Senior', tags: ['ef-core', 'json-columns', 'primitive-collections', 'modeling'],
  q: r`A team wants to store "flexible product terms" in a JSON column. When do JSON columns and primitive collections fit, how does EF Core 10 map them, and what are the hazards?`,
  a: r`### Mechanisms
- EF 7: JSON via **owned types** with {{ToJson()}}.
- EF 8: **primitive collections** ({{List<string>}}, {{int[]}}) stored as JSON arrays and queryable ({{Contains}}, {{Any}}, indexing into the array).
- EF 10: **complex types to JSON** and complex collections, the native SQL Server 2025 / Azure SQL **json** type, and {{ExecuteUpdate}} of JSON properties. Queries translate to {{JSON_VALUE}} / {{OPENJSON}}.

### Use JSON when
- The data is **read and written as a unit** with its owner: provider payloads, extension attributes, versioned terms documents, UI preferences.
- Shape varies by product or version and you do not query inside it on hot paths.

### Do not use JSON when
You **filter, join, sort, aggregate, constrain or reference** a field. JSON fields have no per-field statistics, no foreign keys and no CHECK constraints (beyond {{ISJSON}}), and indexing needs computed columns. Rule: **the moment a field is queried on a hot path, promote it to a column.** Amounts and statuses are never JSON-only.

### Hazards
- **EF 10 migration surprise**: with {{UseAzureSql}} or a compatibility level of 170+, existing {{nvarchar(max)}} JSON columns are changed to the {{json}} type on the next migration. Opt out by pinning the column type, or plan it.
- **Schema evolution**: old documents must stay readable for years. Store a {{schemaVersion}} and upgrade on read, or migrate in batches.
- Large documents bloat rows and every query that selects the owner (project them out).
- Partial updates rewrite the whole document unless the provider supports targeted JSON modification.`,
  code: r`~~~csharp
public sealed record ProductTerms(int SchemaVersion, decimal? EarlyRepaymentFeePct, int? NoticeDays, List<string> EligibleSegments);

modelBuilder.Entity<Product>(b =>
{
    b.ComplexProperty(p => p.Terms, t => t.ToJson());              // EF 10: complex type stored as JSON
    b.PrimitiveCollection(p => p.Tags);                             // EF 8+: JSON array, queryable
    b.Property(p => p.InterestRate).HasPrecision(9, 6);             // queried and reported: a real column
});

// Queries inside JSON translate (JSON_VALUE / OPENJSON); fine for admin screens, not for hot paths
var noticeProducts = await db.Products.Where(p => p.Terms.NoticeDays > 30).ToListAsync(ct);
var tagged = await db.Products.Where(p => p.Tags.Contains("green")).ToListAsync(ct);

// Promote a hot field: computed column + index (SQL Server)
modelBuilder.Entity<Product>().Property<int?>("NoticeDaysIdx")
    .HasComputedColumnSql("CAST(JSON_VALUE([Terms], '$.NoticeDays') AS int)", stored: true);
modelBuilder.Entity<Product>().HasIndex("NoticeDaysIdx");

// Pin the column type to avoid the EF 10 nvarchar -> json change until you plan it
modelBuilder.Entity<GatewayLog>().Property(g => g.Payload).HasColumnType("nvarchar(max)");

// Upgrade old documents on read
if (product.Terms.SchemaVersion < 3) product.Terms = TermsUpgrader.ToV3(product.Terms);
~~~`,
  pts: [r`JSON for owner-scoped data read and written as a unit.`, r`Never for fields you filter, join, constrain or report on regularly.`, r`EF 8 primitive collections; EF 10 complex types to JSON and native json type.`, r`EF 10 may migrate nvarchar JSON columns to json: pin or plan.`, r`Version documents; promote hot fields to columns.`],
  ex: r`A lending platform stored loan "terms" as JSON; risk later needed to report exposure by notice period across 4 million loans and every report scanned and parsed JSON for 40 minutes. NoticeDays was promoted to an indexed column and the report ran in 20 seconds.`,
  fu: [r`How do you keep a seven-year-old JSON document readable?`, r`How would you index a JSON property on PostgreSQL versus SQL Server?`, r`What is the cost of updating one property of a 50 KB document?`],
  pit: [r`JSON as an escape from schema design.`, r`Querying inside JSON on hot paths.`, r`No schema version in documents.`] },

{ id: 'q29', level: 'Senior', tags: ['ef-core', 'query-filters', 'soft-delete', 'multi-tenancy'],
  q: r`We use global query filters for tenant isolation and soft delete. What can defeat them, what changed in EF Core 10, and what do you add as defence in depth?`,
  a: r`A query filter is an implicit {{Where}} added to every query for an entity type. For tenancy it must reference a **context instance member** ({{_tenantId}}) so each context instance parameterises its own value.

### What defeats or surprises
1. **One filter per entity before EF 10**: a second {{HasQueryFilter}} replaces the first, so tenant and soft-delete must be combined with {{&&}}, and {{IgnoreQueryFilters()}} disables **both**. EF 10 adds **named filters** and {{IgnoreQueryFilters(["SoftDelete"])}} to disable one selectively.
2. **Required navigation to a filtered principal**: the join becomes an INNER JOIN, so dependents whose principal is filtered **silently disappear** (Microsoft's example returns 6 posts without the include and 3 with it). Make the navigation optional or filter both sides consistently.
3. **Raw SQL**: {{ExecuteSql}}, Dapper and non-composable {{FromSql}} bypass filters.
4. **Writes are not filtered**: nothing stops inserting a row with another tenant's id; validate {{TenantId}} in a SaveChanges interceptor.
5. **Pooled contexts**: a tenant field set once leaks across leases.
6. Filters only on the **root** of an inheritance hierarchy; not supported with compiled models.

### Soft delete specifics
- An interceptor converts {{Deleted}} to {{Modified}} with {{IsDeleted = true}}.
- **Unique indexes must be filtered** ({{WHERE IsDeleted = 0}}) or re-creating a deleted record fails.
- {{ExecuteDelete}} performs a **real** delete.

### Defence in depth for tenancy
Filters are a convenience, **not a security boundary**. Add database **Row-Level Security** with {{SESSION_CONTEXT}} set by a connection interceptor on every connection open, a write-side interceptor, and automated tests that attempt cross-tenant reads and writes.`,
  code: r`~~~csharp
public sealed class PaymentsDbContext(DbContextOptions<PaymentsDbContext> o, ITenantAccessor tenant) : DbContext(o)
{
    private Guid TenantId => tenant.TenantId ?? Guid.Empty;     // fail closed

    protected override void OnModelCreating(ModelBuilder mb)
    {
        // EF 10 named filters: disable one without the other
        mb.Entity<Payment>().HasQueryFilter("Tenant", p => p.TenantId == TenantId);
        mb.Entity<Payment>().HasQueryFilter("SoftDelete", p => !p.IsDeleted);
        mb.Entity<Payment>().HasIndex(p => new { p.TenantId, p.Reference }).IsUnique().HasFilter("[IsDeleted] = 0");
    }
}

// Admin view of deleted rows, tenant filter still on
var deleted = await db.Payments.IgnoreQueryFilters(["SoftDelete"]).Where(p => p.IsDeleted).ToListAsync(ct);

// Write-side guard + soft delete conversion
public sealed class TenantWriteGuard(ITenantAccessor tenant) : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData e, InterceptionResult<int> r, CancellationToken ct = default)
    {
        foreach (var entry in e.Context!.ChangeTracker.Entries<ITenantOwned>())
        {
            if (entry.Entity.TenantId != tenant.TenantId) throw new SecurityException("Cross-tenant write blocked");
            if (entry.State == EntityState.Deleted && entry.Entity is ISoftDeletable sd)
            { entry.State = EntityState.Modified; sd.IsDeleted = true; }
        }
        return base.SavingChangesAsync(e, r, ct);
    }
}

// RLS session context on every connection open
public sealed class TenantSessionContext(ITenantAccessor tenant) : DbConnectionInterceptor
{
    public override async Task ConnectionOpenedAsync(DbConnection c, ConnectionEndEventData e, CancellationToken ct = default)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "EXEC sys.sp_set_session_context @key = N'TenantId', @value = @t;";
        var p = cmd.CreateParameter(); p.ParameterName = "@t"; p.Value = tenant.TenantId ?? Guid.Empty; cmd.Parameters.Add(p);
        await cmd.ExecuteNonQueryAsync(ct);
    }
}
~~~`,
  pts: [r`Filters bind to a context member; fail closed when the tenant is unknown.`, r`Pre-EF 10 one filter per entity; EF 10 named filters allow selective ignoring.`, r`Required navigations to filtered principals silently drop rows.`, r`Raw SQL, writes and pooled contexts bypass or break filters.`, r`Defence in depth: write interceptor, RLS via SESSION_CONTEXT, cross-tenant tests.`],
  ex: r`An admin export used IgnoreQueryFilters() to include soft-deleted invoices and, because both filters were combined, exported every tenant's invoices to one customer. EF 10 named filters, RLS in the database and a test that runs every admin query under two tenants now guard it.`,
  fu: [r`How does RLS behave when a pooled connection serves two tenants sequentially?`, r`How would you detect the required-navigation defect automatically?`, r`How do cross-tenant reports for internal staff work safely?`],
  pit: [r`Treating the filter as authorization.`, r`IgnoreQueryFilters() to bypass soft delete only.`, r`Unfiltered unique indexes on soft-deleted tables.`] },

{ id: 'q30', level: 'Senior', tags: ['ef-core', 'streaming', 'connection-pool', 'resilience'],
  q: r`An export endpoint uses await foreach over AsAsyncEnumerable(), and the incident review links it to connection-pool exhaustion across the whole API. Explain streaming vs buffering, the failure, and the fix.`,
  a: r`### Buffering vs streaming
- {{ToListAsync()}} **buffers**: reads all rows, releases the connection, then your code runs.
- {{AsAsyncEnumerable()}} / {{await foreach}} **streams**: the {{DbDataReader}} and its **connection stay open for the whole enumeration**.

Streaming saves memory for large results, but the connection is held as long as your loop body takes.

### The failure
Inside the loop the export awaited an HTTP call (or a slow client write). Each export pinned a pooled connection for minutes. Users retried slow exports, multiplying them. With the default **Max Pool Size of 100**, exports alone exhausted the pool; every other request waited and failed with "**Timeout expired... obtaining a connection from the pool**". When the trigger passed, retries kept the pool saturated: a **metastable failure**.

Note: a **retrying execution strategy forces buffering**, so streaming exports and {{EnableRetryOnFailure}} conflict.

### The fix
1. Never await non-database I/O while a reader is open; read a chunk, release, then process.
2. Export in **keyset chunks** (for example 2,000 rows per query), each buffered.
3. Give exports a **bulkhead**: a separate context registration with its own connection string ({{Application Name=exports; Max Pool Size=5}}), no retry strategy, its own timeout, and a concurrency limit on the endpoint.
4. Run large exports as **background jobs** producing a file, not as long HTTP responses.
5. Alert on **pool wait count** (a leading indicator), not just on timeouts.`,
  code: r`~~~csharp
// Anti-pattern: connection held while awaiting HTTP per row
await foreach (var p in db.Payments.AsNoTracking().Where(p => p.MerchantId == m).AsAsyncEnumerable().WithCancellation(ct))
    await enrichmentClient.EnrichAsync(p, ct);       // pool connection pinned for the whole loop

// Fix: keyset chunks, buffered; connection released between chunks
long lastId = 0;
while (true)
{
    var chunk = await exportsDb.Payments.AsNoTracking()
        .Where(p => p.MerchantId == m && p.Id > lastId)
        .OrderBy(p => p.Id).Take(2_000)
        .Select(p => new ExportRow(p.Id, p.Amount.Amount, p.Amount.Currency, p.CreatedUtc))
        .ToListAsync(ct);                               // connection returned here
    if (chunk.Count == 0) break;
    await writer.WriteAsync(chunk, ct);                // slow I/O with no connection held
    lastId = chunk[^1].Id;
}

// Bulkhead: separate pool, no retries, own app name for monitoring
builder.Services.AddDbContextFactory<ExportsDbContext>(o => o.UseSqlServer(
    builder.Configuration.GetConnectionString("PaymentsExports"),           // ...;Application Name=exports;Max Pool Size=5
    sql => sql.CommandTimeout(120)));
app.MapGet("/exports/payments", ExportHandler).RequireRateLimiting("exports");   // concurrency limiter, e.g. 3
~~~`,
  pts: [r`ToListAsync buffers and frees the connection; AsAsyncEnumerable holds it for the loop.`, r`Awaiting other I/O while streaming pins connections; retries multiply it.`, r`Retrying execution strategies force buffering.`, r`Keyset chunks, a separate small pool and concurrency limits isolate exports.`, r`Alert on pool wait count, the leading indicator.`],
  ex: r`A merchant portal's CSV export streamed rows while calling a currency service per row. During a slow FX dependency incident 100 exports held all connections and the whole payments API returned 500s for 22 minutes, continuing after the FX service recovered because users kept retrying. Chunked exports in a separate pool ended the class of incident.`,
  fu: [r`How would you reproduce this failure in a game day?`, r`What does sys.dm_exec_sessions show while it happens?`, r`When is streaming genuinely the right choice?`],
  pit: [r`Raising Max Pool Size to "fix" pool timeouts.`, r`Long-running exports on the request path.`, r`Retries without a budget.`] },

{ id: 'q31', level: 'Senior', tags: ['ef-core', 'compiled-queries', 'compiled-models', 'performance'],
  q: r`A colleague wants EF.CompileAsyncQuery on every query, compiled models and context pooling everywhere. Respond with numbers and an order of operations.`,
  a: r`### What each does
- **Compiled queries** ({{EF.CompileAsyncQuery}}): skip expression-tree processing and the cache lookup for one fixed query shape.
- **Compiled models** ({{dotnet ef dbcontext optimize}}): generate model-building code to cut **startup** time for very large models (hundreds to thousands of entity types).
- **Context pooling**: reuse context instances.

### The numbers (Microsoft's benchmarks, single row, local database)
| Optimisation | Before → after | Saving |
|---|---|---|
| Compiled query | 671.6 → 564.2 µs | about 100 µs (16%) |
| Context pooling | 701.6 → 350.1 µs | about 350 µs |

Against a realistic 5 ms database call, a compiled query saves about **2%**, pooling about **7%**. They matter for CPU-bound services at very high request rates, not for typical database-bound APIs.

### Limits
- Compiled queries: one fixed shape, **scalar parameters only**, no dynamic composition, tied to one context type.
- Compiled models: **no global query filters** (a deal breaker for most multi-tenant apps), no lazy-loading or change-tracking proxies, must be **regenerated** whenever the model changes (add it to CI).
- Pooling: per-request state hazards.

### Order of operations
1. **SQL and indexes**: scans, missing indexes, implicit conversions (orders of magnitude).
2. **Round trips and data volume**: N+1, over-fetching, cartesian explosion (10x).
3. **Tracking and projection**: no-tracking, DTOs (2x to 10x on CPU and memory).
4. **Then**, on a profiled hot path: pooling, compiled queries (single-digit percent).

Also {{EnableThreadSafetyChecks(false)}} saves a little, only after proving no concurrent use.`,
  code: r`~~~csharp
// Hot, fixed-shape lookup called 20,000 times per second
private static readonly Func<PaymentsDbContext, Guid, CancellationToken, Task<PaymentDto?>> GetPayment =
    EF.CompileAsyncQuery((PaymentsDbContext db, Guid id, CancellationToken ct) =>
        db.Payments.AsNoTracking().TagWith("GetPayment")
          .Where(p => p.PublicId == id)
          .Select(p => new PaymentDto(p.PublicId, p.Amount.Amount, p.Amount.Currency, p.Status))
          .SingleOrDefault());

var dto = await GetPayment(db, id, ct);

// Compiled model for startup of a 900-entity model (regenerate in CI on every model change)
// dotnet ef dbcontext optimize --output-dir CompiledModels --namespace Payments.Data.CompiledModels
options.UseModel(Payments.Data.CompiledModels.PaymentsDbContextModel.Instance);

// Measure first
[MemoryDiagnoser]
public class LookupBench
{
    [Benchmark(Baseline = true)] public Task<PaymentDto?> Linq() => Queries.GetPaymentLinq(_db, _id, default);
    [Benchmark] public Task<PaymentDto?> Compiled() => GetPayment(_db, _id, default);
}
~~~`,
  pts: [r`Compiled queries save about 100 µs; pooling about 350 µs; compiled models only help startup.`, r`Against real database latency they are single-digit percent.`, r`Compiled models forbid global query filters and need regeneration.`, r`Fix SQL, round trips and tracking first.`, r`Optimise only profiled hot paths, with benchmarks.`],
  ex: r`A team spent a sprint converting 200 queries to compiled queries for a 3% gain while their slowest endpoint scanned 60 million rows on a missing index. One index cut that endpoint from 4 s to 12 ms; the compiled queries were kept on only five hot lookups.`,
  fu: [r`How large is a "large model" for compiled models to matter?`, r`What is the status of precompiled queries for Native AOT?`, r`How would you prove that context creation is a hotspot?`],
  pit: [r`Micro-optimising EF while queries scan.`, r`Compiled models in a multi-tenant app relying on query filters.`, r`Forgetting to regenerate compiled models.`] },

{ id: 'q32', level: 'Senior', tags: ['ef-core', 'sql-server', 'implicit-conversion', 'parameter-sniffing'],
  q: r`Lookups by ISIN (a varchar(12) column) went from 4 ms to 900 ms after a "model regeneration" commit. Diagnose CONVERT_IMPLICIT, parameter type mismatches and parameter sniffing in an EF Core application.`,
  a: r`### Root cause
EF maps {{string}} to **nvarchar** unless configured with {{IsUnicode(false)}}. Comparing an {{nvarchar}} parameter with a **varchar column** makes SQL Server convert the **column** (nvarchar has higher data-type precedence): {{CONVERT_IMPLICIT}} on every row, and an **index seek becomes a scan** of 60 million rows. Here {{dotnet ef dbcontext scaffold --force}} overwrote the generated configuration and removed a hand-added {{IsUnicode(false).HasMaxLength(12)}}.

### Triage path
1. EF metrics flat (no cache misses, no pool waits): not an EF-side problem.
2. Query Store top consumer, found by its {{TagWith}} name: the **plan changed from seek to scan**.
3. The actual plan shows a **CONVERT_IMPLICIT warning**; the SQL log shows {{@p0 nvarchar(4000)}}.
4. Git: the commit regenerated scaffolded files.

### Fix and prevention
- Restore the mapping in a **partial configuration class** that scaffolding never overwrites.
- Global convention for ASCII families (ISIN, IBAN, currency codes): {{IsUnicode(false)}} with exact lengths.
- **Catalog cross-check test**: compare each mapped property's unicode flag and length with {{INFORMATION_SCHEMA.COLUMNS}}.
- **Parameter-type snapshot tests** for critical queries.
- Query Store **plan-change alerts** on tagged critical queries; a production-sized performance environment.

### Related: parameter sniffing
Same SQL, different plan quality depending on the first parameter values compiled (a merchant with 10 rows vs one with 10 million). Options: index so both values seek, {{OPTION (RECOMPILE)}} or {{OPTIMIZE FOR UNKNOWN}} via raw SQL or a {{DbCommandInterceptor}} for that tagged query, Query Store plan forcing, SQL Server 2022 parameter-sensitive plan optimisation.

### Similar mismatches
{{decimal}} precision differences, {{DateTime}} vs {{datetime}}/{{datetime2}}, and {{string}} lengths ({{nvarchar(4000)}} parameters vs {{varchar(12)}} columns) produce the same class of bug.`,
  code: r`~~~csharp
// Partial configuration that scaffolding will not overwrite
public partial class InstrumentConfiguration
{
    partial void OnConfigurePartial(EntityTypeBuilder<Instrument> b)
    {
        b.Property(i => i.Isin).HasMaxLength(12).IsUnicode(false).IsFixedLength();
    }
}

// Convention for code families modelled as value types (strongly typed codes map to varchar)
protected override void ConfigureConventions(ModelConfigurationBuilder c) =>
    c.Properties<Isin>().HaveConversion<IsinConverter>().AreUnicode(false).HaveMaxLength(12);

// Catalog cross-check test against the real database
[Fact]
public async Task Mapped_string_types_match_the_catalog()
{
    await using var db = fixture.CreateContext();
    var cols = await db.Database.SqlQuery<ColumnInfo>($"""
        SELECT TABLE_NAME AS TableName, COLUMN_NAME AS ColumnName, DATA_TYPE AS DataType, CHARACTER_MAXIMUM_LENGTH AS MaxLength
        FROM INFORMATION_SCHEMA.COLUMNS WHERE DATA_TYPE IN ('varchar','nvarchar','char','nchar')
        """).ToListAsync();
    foreach (var p in db.Model.GetEntityTypes().SelectMany(e => e.GetProperties()).Where(p => p.ClrType == typeof(string)))
    {
        var col = cols.Single(c => c.TableName == p.DeclaringType.GetTableName() && c.ColumnName == p.GetColumnName());
        Assert.Equal(col.DataType.StartsWith('n'), p.IsUnicode() ?? true);
    }
}

// Targeted sniffing fix for one tagged query via an interceptor
public sealed class RecompileHint : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand cmd, CommandEventData e, InterceptionResult<DbDataReader> r)
    {
        if (cmd.CommandText.StartsWith("-- MerchantStatement", StringComparison.Ordinal)) cmd.CommandText += " OPTION (RECOMPILE)";
        return r;
    }
}
~~~`,
  pts: [r`nvarchar parameter vs varchar column converts the column: seek becomes scan.`, r`Triage: EF metrics, Query Store by tag, actual plan warning, parameter types in logs.`, r`Fix mappings in partial classes; IsUnicode(false) conventions for code families.`, r`Catalog cross-check and parameter-type snapshot tests prevent regressions.`, r`Parameter sniffing: index design, RECOMPILE for tagged queries, plan forcing, PSP.`],
  ex: r`The ISIN lookup regression hit a trading desk's pre-trade checks at market open; p99 went from 4 ms to 900 ms and orders queued. Restoring the mapping took 10 minutes; the catalog cross-check test added afterwards caught two more mismatched columns that had been slow for a year.`,
  fu: [r`Why did staging not show the regression?`, r`How would you apply OPTION (RECOMPILE) to one query without raw SQL everywhere?`, r`What other EF type mappings cause implicit conversions?`],
  pit: [r`Adding an index to "fix" an implicit conversion.`, r`Editing scaffolded files that get overwritten.`, r`Blaming EF without reading the plan.`] },

{ id: 'q33', level: 'Senior', tags: ['ef-core', 'contains', 'parameters', 'upgrades'],
  q: r`ids.Contains(x.Id) generated different SQL after an EF upgrade. Explain how Contains over a list is translated in EF Core 8, 9 and 10, the 2,100-parameter limit, and what you do for 5,000 ids.`,
  a: r`### History
| Version | Translation | Effect |
|---|---|---|
| Before EF 8 | values **inlined as constants**: {{IN (1, 2, 3)}} | a new SQL text per list: plan-cache bloat |
| EF 8 and 9 | one **JSON array parameter** unpacked with {{OPENJSON}} | one plan, but the optimiser has **no cardinality** for the list |
| EF 10 default | **one parameter per element, padded** (8 values become 10 parameters) | few distinct SQL shapes **and** cardinality estimates |

Control it globally with {{UseParameterizedCollectionMode(...)}} (Constant, Parameter, MultipleParameters) or per query with {{EF.Constant(ids)}} / {{EF.Parameter(ids)}}.

### Why the upgrade matters
Every {{Contains}} in the codebase changes SQL, and therefore **plan shapes**. A query that was fast with a JSON parameter and a scan-friendly plan may become better or worse with multiple parameters. Diff the SQL and compare Query Store plans for critical queries during the upgrade.

### Large lists
SQL Server allows **2,100 parameters** per request. With multiple-parameter mode, 5,000 ids fail. Options:
- **Chunk** into batches (for example 1,000) and union the results in memory.
- Use the **JSON mode** for that query ({{OPENJSON}}): one parameter, no limit, poorer estimates.
- Send a **table-valued parameter** or bulk-copy into a **temp/staging table** and join: best estimates and plans for thousands of ids.
- Ask why the client holds 5,000 ids: often the filter belongs in the query itself (a join on the criteria that produced the ids).

### Small fixed sets
For tiny, fixed lists (status codes, roles) **constants** give the best plans: {{EF.Constant}}.`,
  code: r`~~~csharp
// Global choice (EF 10)
options.UseSqlServer(cs, sql => sql.UseParameterizedCollectionMode(ParameterTranslationMode.MultipleParameters));

// Small fixed set: constants are fine and give per-value plans
var open = await db.Payments.Where(p => EF.Constant(OpenStatuses).Contains(p.Status)).ToListAsync(ct);

// Thousands of ids: chunk below the 2,100-parameter limit
var results = new List<PaymentDto>(ids.Count);
foreach (var chunk in ids.Chunk(1_000))
    results.AddRange(await db.Payments.AsNoTracking().Where(p => chunk.Contains(p.Id))
        .Select(p => new PaymentDto(p.PublicId, p.Amount.Amount, p.Amount.Currency, p.Status)).ToListAsync(ct));

// Or: table-valued parameter and a join (best estimates)
var tvp = new DataTable(); tvp.Columns.Add("Id", typeof(long));
foreach (var id in ids) tvp.Rows.Add(id);
var param = new SqlParameter("@ids", SqlDbType.Structured) { TypeName = "dbo.BigIntList", Value = tvp };
var rows = await db.Payments.FromSqlRaw("SELECT p.* FROM dbo.Payments p JOIN @ids i ON i.Id = p.Id", param)
    .AsNoTracking().ToListAsync(ct);
~~~`,
  pts: [r`Pre-8 constants, EF 8/9 one OPENJSON parameter, EF 10 padded multiple parameters.`, r`Each mode trades plan-cache size against cardinality estimates.`, r`An EF upgrade changes every Contains query's SQL: diff and compare plans.`, r`2,100-parameter limit: chunk, JSON mode, or TVP/temp-table joins.`, r`Constants for tiny fixed sets.`],
  ex: r`After an EF 10 upgrade, a reconciliation job passing 6,000 references with Contains started failing with "too many parameters". Moving it to a TVP join fixed the failure and, with real cardinality estimates, reduced the run from 11 minutes to 90 seconds.`,
  fu: [r`Which mode would you choose for role lists vs large id lists?`, r`How do you diff generated SQL across an EF upgrade in CI?`, r`How do you send a TVP through EF Core without raw SQL in business code?`],
  pit: [r`Assuming SQL is stable across EF upgrades.`, r`5,000-element IN lists.`, r`Fetching ids to the client only to send them back.`] },

{ id: 'q34', level: 'Senior', tags: ['ef-core', 'change-tracker', 'bulk-insert', 'performance'],
  q: r`Inserting 200,000 entities with Add in a loop and one SaveChanges is slow and memory-hungry; next month it will be 5 million rows. Explain the change-tracker cost and your bulk-loading ladder.`,
  a: r`### Why Add in a loop degrades
Every tracked entity gets an entry plus a snapshot. {{DetectChanges}} is roughly **O(tracked entities x properties)** and is called by {{SaveChanges}}, {{Entries()}}, {{Local}} and others; memory grows linearly. One context with 200,000 entities means gigabytes and long pauses.

### The ladder
| Rows | Approach | Trade-offs |
|---|---|---|
| up to ~10^4 | {{AddRange}} + one {{SaveChanges}} | simple; EF batches statements |
| 10^4 to 10^5 | **chunks** of 1,000 to 5,000: {{SaveChanges}} then {{ChangeTracker.Clear()}} per chunk; optionally {{AutoDetectChangesEnabled = false}} for pure inserts | bounded memory; atomicity is yours (one surrounding transaction, or resumable chunks) |
| 10^5+ | **SqlBulkCopy into a staging table**, validate, then set-based {{INSERT ... SELECT}} / {{MERGE}} | fastest; validate-then-apply; one transaction possible |
| any | bulk libraries (EFCore.BulkExtensions, linq2db) | fast and convenient; check licensing |

### What bulk routes bypass
SaveChanges **interceptors** (audit stamps, tenant validation, outbox rows), query filters, concurrency tokens and generated-key propagation. That must be a **decision**: re-implement audit in the staging-to-target SQL, validate tenant ids in the load step.

### Operational concerns
- **Idempotent restart**: a load id and per-chunk watermark, or a staging table that is merged on a natural key.
- Log growth and blocking: batch the merge, run off-peak, consider minimal logging ({{TABLOCK}} into an empty staging table).
- Foreign-key order and constraint checks; index maintenance cost on the target.
- Never push millions of rows through an HTTP API body: upload a file, process asynchronously.`,
  code: r`~~~csharp
// Chunked inserts with bounded memory, one transaction for atomicity
db.ChangeTracker.AutoDetectChangesEnabled = false;
await using var tx = await db.Database.BeginTransactionAsync(ct);
foreach (var chunk in records.Chunk(2_000))
{
    db.Transactions.AddRange(chunk.Select(Map));
    await db.SaveChangesAsync(ct);
    db.ChangeTracker.Clear();
}
await tx.CommitAsync(ct);

// 5 million rows: SqlBulkCopy into staging, then set-based apply sharing EF's connection and transaction
var conn = (SqlConnection)db.Database.GetDbConnection();
await db.Database.OpenConnectionAsync(ct);
await using var bulkTx = await db.Database.BeginTransactionAsync(ct);
using (var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock, (SqlTransaction)bulkTx.GetDbTransaction())
       { DestinationTableName = "stg.StatementLines", BatchSize = 50_000, EnableStreaming = true })
{
    await bulk.WriteToServerAsync(reader, ct);       // IDataReader over the file: no full materialisation
}
var inserted = await db.Database.ExecuteSqlAsync($"""
    INSERT dbo.StatementLines (LoadId, AccountId, BookedUtc, Amount, Currency, Reference, CreatedBy)
    SELECT {loadId}, s.AccountId, s.BookedUtc, s.Amount, s.Currency, s.Reference, {userId}
    FROM stg.StatementLines s
    WHERE s.LoadId = {loadId}
      AND NOT EXISTS (SELECT 1 FROM dbo.StatementLines t WHERE t.AccountId = s.AccountId AND t.Reference = s.Reference)
    """, ct);                                          // idempotent on restart; audit column set explicitly
await bulkTx.CommitAsync(ct);
~~~`,
  pts: [r`DetectChanges cost grows with tracked entities; memory grows linearly.`, r`AddRange for small sets, chunk + Clear for medium, SqlBulkCopy + staging for large.`, r`Bulk routes bypass interceptors, filters and tokens: re-implement audit deliberately.`, r`Make loads idempotent and resumable.`, r`Never stream millions of rows through an API body.`],
  ex: r`A statement import of 5 million lines with Add in a loop ran 9 hours and was killed by the OOM killer. SqlBulkCopy into staging plus a set-based merge ran in 4 minutes; the audit columns that the interceptor used to set were moved into the merge SQL after a review caught the gap.`,
  fu: [r`How do you make a chunked load resumable after a crash at chunk 1,700?`, r`What changes with identity keys when batching inserts?`, r`How would you minimise transaction-log growth?`],
  pit: [r`One context tracking millions of entities.`, r`Disabling AutoDetectChanges and then modifying entities.`, r`Silent loss of audit and tenant checks in bulk paths.`] },

{ id: 'q35', level: 'Senior', tags: ['ef-core', 'transactions', 'isolation', 'savepoints'],
  q: r`When do you go beyond the implicit SaveChanges transaction? Cover explicit transactions, savepoints, sharing with Dapper, TransactionScope, and choosing an isolation level.`,
  a: r`### Default
Each {{SaveChanges}} is atomic on its own. Many units of work need nothing else.

### Explicit transactions
{{BeginTransactionAsync(IsolationLevel)}} when one unit spans several {{SaveChanges}} calls, {{ExecuteUpdate}} calls or raw SQL. With a retrying execution strategy, wrap it in {{strategy.ExecuteAsync}}.

### Savepoints
Inside an explicit transaction, SaveChanges creates a savepoint and rolls back to it on failure, so the outer transaction stays usable. You can create your own ({{CreateSavepointAsync}}). Savepoints are **incompatible with MARS**.

### Sharing a transaction
- Two contexts on one connection: {{UseTransactionAsync(tx.GetDbTransaction())}} on the second.
- **Dapper / ADO.NET** inside the same unit: use {{db.Database.GetDbConnection()}} and pass {{tx.GetDbTransaction()}}.

### TransactionScope
Works with SqlClient but needs {{TransactionScopeAsyncFlowOption.Enabled}} for async code, cannot commit asynchronously, and escalates to a **distributed transaction** when a second connection is opened. Distributed transactions are supported only on **Windows** since .NET 7 with explicit opt-in. Do not span services with transactions: use the **outbox** and **sagas**.

### Isolation
| Level | Use |
|---|---|
| READ COMMITTED + **RCSI** | default for OLTP: readers do not block writers (Azure SQL Database has it on; boxed SQL Server does not) |
| SNAPSHOT | consistent multi-query reads (split queries, reports); write conflicts raise 3960 |
| REPEATABLE READ / SERIALIZABLE | invariants across rows, short transactions only; deadlock risk rises |

Choose the **lowest level that preserves the invariant**, keep transactions short, and **never** hold one open across an HTTP call or user think time.`,
  code: r`~~~csharp
var strategy = db.Database.CreateExecutionStrategy();
await strategy.ExecuteAsync(async () =>
{
    await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);

    // EF work
    var journal = Journal.Post(entries);
    db.Journals.Add(journal);
    await db.SaveChangesAsync(ct);

    // Set-based EF statement in the same transaction
    await db.Accounts.Where(a => accountIds.Contains(a.Id))
        .ExecuteUpdateAsync(s => s.SetProperty(a => a.LastPostedUtc, DateTime.UtcNow), ct);

    // Dapper in the same transaction (hint LINQ cannot express)
    var conn = db.Database.GetDbConnection();
    await conn.ExecuteAsync("UPDATE dbo.Limits WITH (UPDLOCK) SET Used = Used + @amt WHERE DeskId = @desk",
        new { amt = journal.Total, desk = journal.DeskId }, tx.GetDbTransaction());

    // Optional partial work with a savepoint
    await tx.CreateSavepointAsync("BeforeNotifications", ct);
    try { db.Notifications.AddRange(Notify(journal)); await db.SaveChangesAsync(ct); }
    catch (DbUpdateException) { await tx.RollbackToSavepointAsync("BeforeNotifications", ct); db.ChangeTracker.Clear(); }

    await tx.CommitAsync(ct);
});

// Consistent report across several queries
await using var snap = await db.Database.BeginTransactionAsync(IsolationLevel.Snapshot, ct);
~~~`,
  pts: [r`SaveChanges is atomic alone; explicit transactions for multi-step units.`, r`Wrap explicit transactions in the execution strategy when retries are on.`, r`Savepoints protect the outer transaction; not with MARS.`, r`Share transactions with Dapper via GetDbConnection and GetDbTransaction.`, r`Avoid TransactionScope across connections; lowest isolation that keeps the invariant.`],
  ex: r`A posting service wrapped a call to a sanctions API inside its transaction; when the API slowed to 8 seconds, locks on hot accounts were held for 8 seconds and the posting queue backed up across all desks. Moving the call before the transaction (with an idempotency key) kept transactions under 20 ms.`,
  fu: [r`How do you prove an isolation level preserves a given invariant?`, r`What happens to the change tracker after rolling back to a savepoint?`, r`Why does TransactionScope escalate to a distributed transaction?`],
  pit: [r`TransactionScope around HTTP calls.`, r`SERIALIZABLE by default.`, r`MARS on with savepoints expected to work.`] },

{ id: 'q36', level: 'Senior', tags: ['ef-core', 'testing', 'testcontainers', 'quality'],
  q: r`How do you test code that uses EF Core? Compare the in-memory provider, SQLite, mocking DbSet, repositories and a real database, and describe the test layers you require.`,
  a: r`### Options and their gaps
| Option | Gap |
|---|---|
| **InMemory provider** | not relational: no transactions, no constraints, no raw SQL, different case sensitivity, no real concurrency. Microsoft discourages it for testing |
| **Mocking DbSet** | complex, and tests your mocks, not translation |
| **SQLite in-memory** | relational but different: types, collation, functions, no {{EF.Functions}} of SQL Server, different locking |
| **Repository + mocks** | changes the architecture to suit tests and excludes EF behaviour from them |
| **Real engine** (Testcontainers) | slower to start; the only one that tests what production runs |

### My standard
- **Domain unit tests** with no EF at all: the bulk of tests, fast.
- **Integration tests on the production engine and major version** (SQL Server in Testcontainers), one container per test run; schema created by **applying the real migrations** (never {{EnsureCreated}}); state reset with **Respawn** or per-test transactions.
- **Migration tests**: apply from empty and from the previous release; {{HasPendingModelChanges()}} must be false.
- **Concurrency tests**: two contexts racing on the same row or account.
- **Query-shape tests**: command counts (N+1), SQL or parameter-type snapshots for critical queries.
- **Model-rule tests**: no unbounded strings, no default decimals, explicit delete behaviour.
- A few end-to-end tests with {{WebApplicationFactory}}.

"Too slow" is a fixture-design problem (shared container, Respawn); "flaky" is an isolation problem.`,
  code: r`~~~csharp
public sealed class SqlFixture : IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder().WithImage("mcr.microsoft.com/mssql/server:2022-latest").Build();
    private Respawner _respawner = null!;
    public string ConnectionString => _sql.GetConnectionString();

    public PaymentsDbContext CreateContext(params IInterceptor[] interceptors) =>
        new(new DbContextOptionsBuilder<PaymentsDbContext>().UseSqlServer(ConnectionString).AddInterceptors(interceptors).Options,
            new FixedTenant(TestTenants.A));

    public async Task InitializeAsync()
    {
        await _sql.StartAsync();
        await using var db = CreateContext();
        await db.Database.MigrateAsync();                                   // real migrations
        Assert.False(db.Database.HasPendingModelChanges());
        _respawner = await Respawner.CreateAsync(ConnectionString, new() { TablesToIgnore = ["__EFMigrationsHistory"] });
    }
    public Task ResetAsync() => _respawner.ResetAsync(ConnectionString);
    public Task DisposeAsync() => _sql.DisposeAsync().AsTask();
}

[Fact]
public async Task Two_concurrent_debits_cannot_overdraw()
{
    await fixture.SeedAccountAsync(id: 1, balance: 100m);
    var debit = (decimal amt) => Task.Run(async () =>
    {
        await using var db = fixture.CreateContext();
        return await new AccountService(db).DebitAsync(1, amt, CancellationToken.None);
    });
    var results = await Task.WhenAll(debit(80m), debit(80m));
    Assert.Single(results, r => r == DebitResult.Ok);
    await using var check = fixture.CreateContext();
    Assert.Equal(20m, (await check.Accounts.SingleAsync(a => a.Id == 1)).Balance);
}
~~~`,
  pts: [r`InMemory and mocked DbSets miss constraints, transactions and translation.`, r`SQLite differs from SQL Server in important ways.`, r`Real engine via Testcontainers, schema from real migrations, Respawn resets.`, r`Layers: domain units, integration, migration, concurrency, query-shape, model-rule.`, r`Slow and flaky are fixture and isolation problems, not reasons to fake the database.`],
  ex: r`A team's 1,400 tests on the InMemory provider were green while production failed on a unique constraint, a cascade path and a translation error in the same release. Moving integration tests to a shared SQL Server container with Respawn added 90 seconds to CI and caught all three classes before merge.`,
  fu: [r`How do you run integration tests in parallel against one container?`, r`How would you test a deadlock-retry path?`, r`What belongs in a query-shape snapshot test?`],
  pit: [r`InMemory provider for logic that depends on constraints or transactions.`, r`EnsureCreated in tests while production uses migrations.`, r`A different SQL Server major version in tests.`] },

{ id: 'q37', level: 'Principal', tags: ['ef-core', 'architecture', 'dapper', 'repository', 'migration'],
  q: r`Three stances a principal must settle: EF Core vs Dapper vs ADO.NET across the platform, whether to wrap EF in repositories, and how to lead a migration off EF6 on .NET Framework.`,
  a: r`### EF Core vs Dapper
EF Core has four cooperating subsystems: **model**, **query pipeline**, **change tracker** and **update pipeline** (ordered, batched, transactional SaveChanges). Its design centre is **transactional, aggregate-shaped work** with centrally enforced rules (tenant filters, soft delete, audit, concurrency tokens).

Poor fits: reporting where the SQL is the artefact, bulk loads, complex set-based updates, heavy use of hints and window functions.

**Policy: EF Core by default; Dapper or raw SQL by measured exception.** Microsoft's own guidance ranks the costs as database work, network transfer, round trips, and only then EF overhead, which is "likely negligible in most cases". Most "EF is slow" claims are N+1, over-fetching, tracking read-only data or missing indexes. Both can share one {{DbConnection}} and transaction. Never two idioms in one feature without a written reason.

### Repositories
{{DbContext}} already *is* a unit of work and {{DbSet}} a repository. A **generic pass-through repository** that re-exposes {{IQueryable}} is a leaky, redundant layer; mocking it tests the mocks. Use:
- **Aggregate repositories on the write side** ({{IPaymentRepository.GetAsync(id)}}, {{Add}}): a domain contract that loads whole aggregates.
- **Direct query objects with projections on the read side** (CQRS-style), tested against the real database.

### EF6 to EF Core
It is a **port**, not an upgrade. EF Core 10 requires **.NET 10** and does not run on .NET Framework, so runtime and ORM move together.
1. Inventory: EDMX models, lazy-loading reliance, {{ObjectContext}} usage, {{SqlQuery}}, stored procedure mappings, TPT/TPH assumptions, entity splitting.
2. Scaffold code-first from the database; drop the designer.
3. Write **behaviour-difference tests**: lazy loading is opt-in, client evaluation throws, string comparison and collation, tracking and cascade defaults.
4. **Strangler** by bounded context, with side-by-side **parity tests** (same inputs, same results) before switching traffic.`,
  dia: r`flowchart LR
  W[Write side: commands] --> R[Aggregate repository]
  R --> C[DbContext tracking, SaveChanges]
  Q[Read side: queries] --> P[Query objects with projections]
  P --> C2[DbContext no-tracking]
  Q --> D[Dapper or SQL views for reports]
  C --> DB[(SQL Server)]
  C2 --> DB
  D --> DB`,
  code: r`~~~csharp
// Write side: aggregate repository with a domain contract
public interface IPaymentRepository
{
    Task<Payment?> GetAsync(PaymentId id, CancellationToken ct);
    void Add(Payment payment);
}
public sealed class PaymentRepository(PaymentsDbContext db) : IPaymentRepository
{
    public Task<Payment?> GetAsync(PaymentId id, CancellationToken ct) =>
        db.Payments.Include(p => p.Refunds).SingleOrDefaultAsync(p => p.Id == id, ct);   // whole aggregate
    public void Add(Payment payment) => db.Payments.Add(payment);
}

// Read side: query object with projection
public sealed class MerchantDashboardQuery(PaymentsDbContext db)
{
    public Task<List<DailyTotal>> RunAsync(long merchantId, DateOnly from, CancellationToken ct) =>
        db.Payments.AsNoTracking().TagWith("Dashboard.DailyTotals")
          .Where(p => p.MerchantId == merchantId && p.ValueDate >= from)
          .GroupBy(p => p.ValueDate)
          .Select(g => new DailyTotal(g.Key, g.Count(), g.Sum(p => p.Amount.Amount)))
          .ToListAsync(ct);
}

// Measured exception: Dapper for a reporting query, sharing EF's connection
var conn = db.Database.GetDbConnection();
var aging = await conn.QueryAsync<AgingBucket>("dbo.Report_ReceivablesAging", new { asOf }, commandType: CommandType.StoredProcedure);
~~~`,
  pts: [r`EF Core by default for transactional, aggregate-shaped work; Dapper by measured exception.`, r`EF overhead is usually the smallest of the four latency factors.`, r`No generic repositories; aggregate repositories for writes, projections for reads.`, r`EF6 to EF Core is a port coupled to the .NET runtime move.`, r`Strangler by bounded context with parity tests.`],
  ex: r`A platform team mandated Dapper everywhere after one slow EF endpoint; within a year 40 services had hand-written tenant filters, three of them wrong. The policy was reversed to EF by default, with a documented Dapper exception list (reports, two hot lookups) backed by benchmarks.`,
  fu: [r`How would you measure EF overhead for your own workload?`, r`When would you add a repository on the read side?`, r`What breaks first when porting EF6 lazy-loading code?`],
  pit: [r`"EF is slow" without a measurement.`, r`Generic repositories for testability.`, r`Big-bang EF6 ports.`] },

{ id: 'q38', level: 'Principal', tags: ['ef-core', 'connection-pooling', 'capacity', 'resilience'],
  q: r`Connection pool vs context pool: average load is 6,000 database calls per second at 4 ms across 20 pods, and SQL Server has 16 vCPUs. What Max Pool Size do you set and why?`,
  a: r`### Two different pools
- The **ADO.NET connection pool**: per connection string per process; default **Max Pool Size 100**, {{Connect Timeout}} 15 s, command timeout 30 s.
- The **EF context pool**: reuses DbContext objects; unrelated to connections.

### The arithmetic
**Little's Law**: busy connections L = λ x W = 6,000/s x 0.004 s = **24** across the fleet. Average demand is tiny.

Defaults allow 20 pods x 100 = **2,000** connections. SQL Server's worker threads at 16 logical CPUs are 512 + (16 − 4) x 16 = **704**. In a brownout where latency rises 100 times (400 ms), demand becomes 6,000 x 0.4 = **2,400** concurrent requests: the database scheduler saturates (THREADPOOL waits) long before any app pool refuses work, and the database cannot recover because every request piles in.

### A design number
Cap total connections below what the database can serve: about 70% of 704 / 20 pods ≈ **25 per pod** (500 total), with a short **Connect Timeout** (around 5 s). When the pool is exhausted, callers fail fast with **503 + Retry-After** instead of queueing; that **load shedding** protects the database.

### What holds connections too long
- Streaming readers with slow awaits inside the loop.
- Transactions held across HTTP calls.
- Sync-over-async ({{.Result}}) and unbounded fan-out ({{Task.WhenAll}} over hundreds of queries).
- Leaked connections (missing dispose).

### Monitoring
Alert on **pool wait count > 0 for 60 s** (leading), active connections per pod, and on the database {{THREADPOOL}} waits and {{sys.dm_exec_sessions}} counts. Raising the pool size to "stop timeouts" hides the signal and melts the database.`,
  code: r`~~~csharp
// Per-pod budget derived from capacity, not defaults
var cs = new SqlConnectionStringBuilder(builder.Configuration.GetConnectionString("Payments"))
{
    MaxPoolSize = 25,                 // floor(0.7 * 704 / 20)
    MinPoolSize = 5,
    ConnectTimeout = 5,               // fail fast instead of queueing
    ApplicationName = "payments-api"  // visible in sys.dm_exec_sessions
}.ConnectionString;
builder.Services.AddDbContext<PaymentsDbContext>(o => o.UseSqlServer(cs, sql => sql.CommandTimeout(10)));

// Shed load explicitly when the pool is exhausted
app.UseExceptionHandler(e => e.Run(async ctx =>
{
    var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
    if (ex is InvalidOperationException { Message: var m } && m.Contains("obtaining a connection from the pool"))
    {
        ctx.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        ctx.Response.Headers.RetryAfter = "2";
    }
}));

// Database side: who holds connections?
// SELECT program_name, status, COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 GROUP BY program_name, status;
~~~`,
  pts: [r`Connection pool and context pool are different things.`, r`Little's Law: 6,000/s x 4 ms = 24 busy connections.`, r`Defaults (2,000) exceed SQL Server's 704 workers: brownouts become meltdowns.`, r`Set a capacity-derived cap per pod with short connect timeouts and 503s.`, r`Alert on pool waits; fix what holds connections rather than raising the cap.`],
  ex: r`During a storage latency spike a 30-pod API with default pools opened 2,600 connections to a 16-vCPU SQL Server; THREADPOOL waits froze the instance and failover did not help because every pod reconnected instantly. Capacity-derived caps and fail-fast timeouts turned the next spike into a brief 503 rate.`,
  fu: [r`How do autoscaling pod counts change the per-pod cap?`, r`What does a 503 with Retry-After require from clients?`, r`How would you detect a connection leak?`],
  pit: [r`Max Pool Size = 1000 "to be safe".`, r`Conflating context pooling with connection pooling.`, r`Ignoring pod count in pool sizing.`] },

{ id: 'q39', level: 'Principal', tags: ['ef-core', 'idempotency', 'exactly-once', 'payments'],
  q: r`Make a payment insert exactly-once with EF Core when the client retries, the execution strategy retries, and the connection can drop during COMMIT.`,
  a: r`**Exactly-once effect = at-least-once delivery + at-most-once application.**

### Where duplicates come from
1. The **client** retries after a timeout (the first request may have succeeded).
2. The **execution strategy** retries after a transient error.
3. **Commit ambiguity**: the connection drops during COMMIT; the client cannot know whether it committed. The strategy retries "as if it rolled back", and with a store-generated key a committed insert happens **twice**.

### The design
- The client sends an **idempotency key** (and the server derives a **request hash** of the body).
- A **unique index on (TenantId, IdempotencyKey)**, written **in the same transaction** as the payment.
- First attempt: insert the idempotency record (status, request hash), the payment and the outbox event; commit; store the response.
- **Duplicate key** (2627 / 2601) on a retry: read the stored record. Same hash: **replay the stored response** (200 / 201). Different hash: **409 / 422**, the client reused a key for a different request. In progress: 409 with Retry-After.
- Use **client-known keys** (HiLo or a GUID) so a blind retry hits the unique key instead of creating a new row, or use {{ExecuteInTransactionAsync}} with **verifySucceeded**.
- Retention: expire idempotency records after the client's maximum retry window (for example 24 to 72 hours).

### Downstream
The payment's side effects (calling the scheme or bank) need the same property: pass the key to the gateway, which must dedupe too. Consumers of the outbox event dedupe on event id.`,
  dia: r`sequenceDiagram
  participant C as Client
  participant A as API
  participant D as SQL Server
  C->>A: POST payment with Idempotency-Key K
  A->>D: BEGIN, insert Idempotency K, Payment, Outbox
  D-->>A: connection drops during COMMIT
  A->>D: retry same unit with key K
  D-->>A: unique violation on K
  A->>D: read stored response for K
  A-->>C: 201 replayed, no second payment`,
  code: r`~~~csharp
public async Task<IResult> CreatePaymentAsync(CreatePayment cmd, string idemKey, CancellationToken ct)
{
    var hash = RequestHash.Of(cmd);
    var strategy = db.Database.CreateExecutionStrategy();
    try
    {
        return await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var payment = Payment.Create(cmd);                                     // HiLo id: known before save
            db.IdempotencyRecords.Add(new IdempotencyRecord(tenant.Id, idemKey, hash, payment.PublicId));
            db.Payments.Add(payment);
            db.Outbox.Add(OutboxMessage.From(new PaymentCreated(payment.PublicId, payment.Amount)));
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return Results.Created($"/payments/{payment.PublicId}", payment.ToDto());
        });
    }
    catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2627 or 2601 })
    {
        db.ChangeTracker.Clear();
        var rec = await db.IdempotencyRecords.AsNoTracking()
            .SingleAsync(r => r.TenantId == tenant.Id && r.Key == idemKey, ct);
        if (rec.RequestHash != hash) return Results.Problem(statusCode: 422, title: "Idempotency key reused with a different request");
        var existing = await db.Payments.AsNoTracking().SingleAsync(p => p.PublicId == rec.PaymentId, ct);
        return Results.Created($"/payments/{existing.PublicId}", existing.ToDto());   // replay
    }
}
~~~`,
  pts: [r`Duplicates come from client retries, strategy retries and commit ambiguity.`, r`Unique (tenant, idempotency key) in the same transaction gives at-most-once.`, r`Duplicate key → replay the stored result; different body → 422 or 409.`, r`Client-known keys or verifySucceeded handle ambiguous commits.`, r`Propagate the key to gateways; consumers dedupe on event id.`],
  ex: r`During a network incident between the app and Azure SQL, 37 payments were committed but reported as failures; the client and EF both retried and 37 customers were charged twice. The idempotency table and replay logic shipped the following week, plus a daily duplicate-detection report as an independent check.`,
  fu: [r`What happens if two requests with the same key arrive concurrently?`, r`How long should idempotency records live, and who decides?`, r`How do you test the commit-ambiguity case?`],
  pit: [r`"The transaction is atomic, so it is safe".`, r`Store-generated keys with no idempotency key.`, r`Ignoring a key reused with a different body.`] },

{ id: 'q40', level: 'Principal', tags: ['ef-core', 'concurrency', 'ledger', 'hot-rows'],
  q: r`Two concurrent debits of 80 hit an account with a balance of 100; only one may succeed. Design it with EF Core, then tell me when even your design saturates.`,
  a: r`### Name the invariant
{{balance >= 0}}. A concurrency token detects that **the row changed**, not that the **rule still holds**; after a conflict you must re-read and re-evaluate, retrying the whole unit.

### Options
1. **Optimistic token + retry the unit**: correct, no blocking, but under contention retries multiply load.
2. **Atomic guarded statement** (best for this rule): {{UPDATE Accounts SET Balance = Balance - @amt WHERE Id = @id AND Balance >= @amt}} via {{ExecuteUpdateAsync}}. Rows affected 1 = debited, 0 = insufficient funds. No read, no lost update, no retry loop; the row lock lasts one statement. Put it **last** in the transaction to minimise lock time.
3. **Pessimistic lock** ({{UPDLOCK}} read, then update) inside a short transaction, when the decision needs several reads.

Add a {{CHECK (Balance >= 0)}} constraint as a **backstop**, an **idempotency key** per debit, and for transfers a **canonical lock order** (lower account id first) to avoid deadlocks.

### When it saturates
A single row serialises its writers. At an 8 ms transaction (lock held for the whole transaction) one row caps at **1 / 0.008 = 125 updates/s**. A merchant account receiving 58 debits/s runs at utilisation 0.46 (mean queueing about 7 ms); at 0.9 queueing grows to about 70 ms and p99 explodes. Optimistic retries turn this into a retry storm.

### Beyond one row
- Shorten lock hold time (statement last, no I/O inside): 2 ms gives 500/s.
- **Append-only ledger** as the source of truth with balances derived or snapshotted; debits check available funds against a reserved-funds model.
- **Shard the balance** into N sub-accounts (N = 8 gives about 7/s per row), summing for reads.
- **Reconciliation** job comparing ledger sums with balances: the independent detector for logic bugs.

Test with concurrent tasks on a real SQL Server, never the in-memory provider.`,
  code: r`~~~csharp
public async Task<DebitResult> DebitAsync(long accountId, decimal amount, string idemKey, CancellationToken ct)
{
    var strategy = db.Database.CreateExecutionStrategy();
    return await strategy.ExecuteAsync(async () =>
    {
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        db.LedgerEntries.Add(new LedgerEntry(accountId, -amount, idemKey));   // unique idemKey: no double debit
        await db.SaveChangesAsync(ct);

        var updated = await db.Accounts                                      // guarded statement, last in the txn
            .Where(a => a.Id == accountId && a.Balance >= amount)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Balance, a => a.Balance - amount), ct);
        if (updated == 0) { await tx.RollbackAsync(ct); return DebitResult.InsufficientFunds; }

        await tx.CommitAsync(ct);
        return DebitResult.Ok;
    });
}

// Backstop constraint
modelBuilder.Entity<Account>().ToTable(t => t.HasCheckConstraint("CK_Account_Balance_NonNegative", "[Balance] >= 0"));

// Transfers: canonical lock order prevents A->B / B->A deadlocks
var (first, second) = from < to ? (from, to) : (to, from);

// Sharded hot balance: pick a shard at random, read the sum
var shard = Random.Shared.Next(8);
await db.MerchantBalanceShards.Where(s => s.MerchantId == m && s.Shard == shard)
    .ExecuteUpdateAsync(s => s.SetProperty(x => x.Balance, x => x.Balance + amount), ct);
var balance = await db.MerchantBalanceShards.Where(s => s.MerchantId == m).SumAsync(s => s.Balance, ct);
~~~`,
  pts: [r`Name the invariant; a token detects change, not rule validity.`, r`A guarded ExecuteUpdate makes check-and-debit atomic: rows affected is the answer.`, r`CHECK constraint backstop, idempotency key, canonical lock order.`, r`One row caps at 1 / lock-hold-time updates per second.`, r`Beyond that: shorter locks, append-only ledger, sharded balances, reconciliation.`],
  ex: r`A marketplace's escrow account took every payout and hit 140 updates/s at peak; optimistic retries pushed p99 to 4 seconds and caused retry storms. Sharding the escrow balance into 16 rows and moving to a guarded update cut p99 to 25 ms, with a nightly reconciliation of shards against the ledger.`,
  fu: [r`How does lock hold time change the ceiling?`, r`How do you detect a logic error that keeps the ledger internally consistent but wrong?`, r`How would reserved funds (authorisations) change the model?`],
  pit: [r`Token-and-retry as the whole answer.`, r`Testing concurrency on the in-memory provider.`, r`Ignoring hot-row throughput limits.`] },

{ id: 'q41', level: 'Principal', tags: ['ef-core', 'deadlocks', 'sql-server', 'incident'],
  q: r`Month-end transfers start failing with "Transaction was deadlocked... chosen as the deadlock victim". Walk through cause, diagnosis and the layered fix in an EF Core application.`,
  a: r`### Cause
**Inconsistent lock ordering**: transfer A→B locks A then B; a concurrent B→A locks B then A; each waits for the other. SQL Server kills one (error **1205**). It was always possible; month-end volume made the overlap routine. Contributing factors: scans instead of seeks (locking more rows), long transactions, and EF's SaveChanges ordering differing from another code path's raw SQL ordering.

### Diagnosis
1. Confirm it is **1205**, not a timeout or pool exhaustion.
2. Pull the **deadlock graph** from the {{system_health}} Extended Events session ({{xml_deadlock_report}}): two {{UPDATE Accounts}} statements holding and requesting key locks in opposite order.
3. Map statements to code with {{TagWith}} comments.
4. Rule out long blocking chains ({{sys.dm_os_waiting_tasks}}).
5. Reproduce in a test with paired opposite-direction transfers in parallel.

### Layered fix
1. **Canonical lock order**: always update the lower account id first, in every code path (EF and raw SQL).
2. **Short transactions**: no I/O inside; the hot-row statement last.
3. **Indexes** so updates seek and lock single rows, not ranges.
4. **RCSI** so readers do not join lock chains.
5. **Retry the whole unit** on 1205 (the victim is fully rolled back, so a retry is safe), with a **fresh context**, jitter, at most 3 attempts, and **idempotency keys**. Check whether your provider's execution strategy already treats 1205 as transient; add it with {{errorNumbersToAdd}} if not.

### Prevention
A CI concurrency test (1,000 paired transfers), a deadlock-count alert per hour, and a code-review rule for multi-row updates.`,
  code: r`~~~csharp
public async Task TransferAsync(long from, long to, decimal amount, string idemKey, CancellationToken ct)
{
    var (first, second) = from < to ? (from, to) : (to, from);       // canonical order
    var strategy = db.Database.CreateExecutionStrategy();             // configured with errorNumbersToAdd: [1205]
    await strategy.ExecuteAsync(async () =>
    {
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        db.Transfers.Add(new Transfer(idemKey, from, to, amount));
        await db.SaveChangesAsync(ct);

        await db.Accounts.TagWith("Transfer.LockFirst").Where(a => a.Id == first)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Balance, a => a.Balance + (a.Id == from ? -amount : amount)), ct);
        await db.Accounts.TagWith("Transfer.LockSecond").Where(a => a.Id == second)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Balance, a => a.Balance + (a.Id == from ? -amount : amount)), ct);

        await tx.CommitAsync(ct);
    });
}

// CI test: opposite-direction transfers in parallel must never deadlock-fail
[Fact]
public async Task Paired_transfers_do_not_deadlock()
{
    var tasks = Enumerable.Range(0, 500).SelectMany(i => new[]
    {
        Run(s => s.TransferAsync(1, 2, 1m, $"a{i}", default)),
        Run(s => s.TransferAsync(2, 1, 1m, $"b{i}", default))
    });
    await Task.WhenAll(tasks);
}
~~~
~~~sql
-- Deadlock graphs from the built-in system_health session
SELECT xed.value('@timestamp', 'datetime2') AS At, xed.query('.') AS Graph
FROM (SELECT CAST(target_data AS xml) AS t FROM sys.dm_xe_session_targets st
      JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
      WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer') x
CROSS APPLY x.t.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS q(xed);
~~~`,
  pts: [r`Opposite lock order across concurrent transactions causes 1205.`, r`Diagnose with system_health deadlock graphs and TagWith attribution.`, r`Canonical ordering in every code path, short transactions, seeks, RCSI.`, r`Retry the whole unit with a fresh context and idempotency keys.`, r`CI concurrency test and deadlock alerts prevent recurrence.`],
  ex: r`A treasury sweep ran transfers between 400 sub-accounts in both directions and deadlocked 3% of its operations at quarter-end, delaying cash positioning by two hours. Canonical ordering by account id plus a retry policy brought deadlocks to zero across the next three quarter-ends.`,
  fu: [r`How do EF's SaveChanges ordering and your explicit ordering interact?`, r`What if the two locks are taken by two different services?`, r`Why is retrying a deadlock victim safe, and when is it not?`],
  pit: [r`"Increase the timeout".`, r`Retries without idempotency.`, r`Ordering fixed in one code path only.`] },

{ id: 'q42', level: 'Principal', tags: ['ef-core', 'outbox', 'messaging', 'reliability'],
  q: r`Save a payment and publish PaymentPosted reliably using EF Core. Design the outbox write, the relay, ordering, delivery semantics and the operational alerts.`,
  a: r`### The problem
Saving then publishing (or publishing then saving) is a **dual write**: a crash between the two loses the event or publishes an event for a change that rolled back.

### The write side
Aggregates raise **domain events**; a {{SaveChangesInterceptor}} turns them into {{OutboxMessage}} rows in **SavingChanges**, so they commit **atomically** with the business change. Store event id, type, aggregate id, payload, occurred time, and a sequence per aggregate.

### The relay
- Claims unpublished rows without double-processing across replicas: raw SQL with {{UPDLOCK, READPAST, ROWLOCK}} on SQL Server ({{FOR UPDATE SKIP LOCKED}} on PostgreSQL), or a lease column set by a guarded {{ExecuteUpdate}}.
- **Keep the claim transaction short**: claim and commit, publish **outside** the transaction, then mark published.
- Preserve **order per aggregate** by publishing with the aggregate id as the message key (Kafka partition key) and processing one aggregate's rows in sequence.
- Alternative: **CDC / log tailing** (Debezium on the outbox table) instead of polling.

### Delivery semantics
**At-least-once**: the relay can publish and crash before marking. Consumers must be **idempotent** (dedupe on event id). Exactly-once *effect* = at-least-once delivery + idempotent consumption.

### Operations
- Filtered index on unpublished rows; **retention purge** of published rows.
- Attempts counter and a dead-letter status after N failures.
- **Alert on the age of the oldest unpublished message**: the only detector of a silently stopped relay.`,
  dia: r`flowchart LR
  A[Command handler] --> B[Aggregate raises domain event]
  B --> C[SaveChanges interceptor adds OutboxMessage]
  C --> D[(One transaction: Payments + Outbox)]
  D --> E[Relay claims rows with UPDLOCK READPAST]
  E --> F[Publish to broker keyed by aggregate id]
  F --> G[Mark published]
  F --> H[Consumers dedupe on event id]
  E -.-> I[Alert: oldest unpublished age]`,
  code: r`~~~csharp
public sealed class OutboxInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData e, InterceptionResult<int> r, CancellationToken ct = default)
    {
        var db = e.Context!;
        var events = db.ChangeTracker.Entries<IHasDomainEvents>()
            .SelectMany(x => x.Entity.DequeueEvents()).ToList();
        db.Set<OutboxMessage>().AddRange(events.Select(OutboxMessage.From));   // same transaction as the change
        return base.SavingChangesAsync(e, r, ct);
    }
}

// Relay: short claim transaction, publish outside it
public async Task<int> RelayOnceAsync(CancellationToken ct)
{
    await using var db = await factory.CreateDbContextAsync(ct);
    List<OutboxMessage> batch;
    await using (var tx = await db.Database.BeginTransactionAsync(ct))
    {
        batch = await db.Outbox.FromSql($"""
            SELECT TOP (100) * FROM dbo.Outbox WITH (UPDLOCK, READPAST, ROWLOCK)
            WHERE PublishedUtc IS NULL AND (LeaseUntil IS NULL OR LeaseUntil < SYSUTCDATETIME())
            ORDER BY Id
            """).ToListAsync(ct);
        foreach (var m in batch) m.LeaseUntil = DateTime.UtcNow.AddMinutes(2);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }
    foreach (var m in batch.OrderBy(m => m.AggregateId).ThenBy(m => m.Sequence))
    {
        await producer.ProduceAsync(m.Topic, new Message<string, string> { Key = m.AggregateId, Value = m.Payload,
            Headers = new Headers { { "event-id", m.EventId.ToByteArray() } } }, ct);
        m.PublishedUtc = DateTime.UtcNow;
    }
    await db.SaveChangesAsync(ct);
    return batch.Count;
}
~~~`,
  pts: [r`Dual writes lose or invent events; the outbox commits events with the change.`, r`SaveChangesInterceptor converts domain events to outbox rows atomically.`, r`Relay: short claim with UPDLOCK READPAST or leases, publish outside the transaction.`, r`At-least-once delivery: consumers dedupe on event id; key by aggregate for order.`, r`Alert on the oldest unpublished message age; purge and dead-letter.`],
  ex: r`A payments service published PaymentPosted after SaveChanges; a pod crash between the two left 1,100 posted payments with no downstream ledger entries, found only at month-end reconciliation. The outbox with an oldest-age alert has since caught two relay stalls within five minutes each.`,
  fu: [r`Polling vs CDC for the relay: trade-offs?`, r`How do you keep per-aggregate order with several relay instances?`, r`How long should published outbox rows be retained?`],
  pit: [r`Publishing inside the database transaction.`, r`Claiming in a long transaction that also publishes.`, r`No alert for a stopped relay.`] },

{ id: 'q43', level: 'Principal', tags: ['ef-core', 'audit', 'temporal-tables', 'bitemporal', 'compliance'],
  q: r`Regulators ask "what did this trade look like at 10:00 on 3 March?" and "what did we believe on 3 March about the trade's terms effective 1 March?". Design audit and history with EF Core.`,
  a: r`### Two time axes
- **System time** (transaction time): when the database recorded a version. Answers question one.
- **Business time** (valid or effective time): when the fact is true in the real world. Question two needs **both** axes: bitemporal.

### System time: temporal tables
SQL Server **system-versioned temporal tables** keep a history row for every change automatically; applications cannot forget. EF Core maps them with {{ToTable(t => t.IsTemporal())}} and queries them with {{TemporalAsOf}}, {{TemporalAll}}, {{TemporalBetween}}, {{TemporalFromTo}}, {{TemporalContainedIn}}. History is read-only through EF.

### Business time: modelled columns
Add {{EffectiveFrom}} / {{EffectiveTo}} to the terms rows (or a versioned terms table). Corrections **supersede** with new rows rather than overwrite. Question two becomes: temporal **AS OF 3 March** combined with **effective on 1 March**.

### Who and why
Temporal tables record *what* and *when*, not *who* or *why*. Add a {{SaveChangesInterceptor}} that stamps {{ModifiedBy}}, {{ModifiedUtc}} and a **change reason / correlation id** on every write, so history rows carry them.

### Integrity and retention
- Append-only permissions for ledger-type tables; corrections by reversal entries.
- SQL Server **ledger tables** for cryptographic tamper evidence where regulators require proof.
- Retention: history grows fast (8 million changes a day at 600 bytes is about 12 TB over 7 years): set {{HISTORY_RETENTION_PERIOD}}, partition and archive history, index history tables for the AS OF access pattern.
- Schema evolution: additive changes only on temporal tables; altering them needs care in migrations.`,
  code: r`~~~csharp
modelBuilder.Entity<Trade>().ToTable("Trades", t => t.IsTemporal(h =>
{
    h.HasPeriodStart("SysStartUtc");
    h.HasPeriodEnd("SysEndUtc");
    h.UseHistoryTable("TradesHistory", "audit");
}));
modelBuilder.Entity<TradeTerms>().HasIndex(t => new { t.TradeId, t.EffectiveFrom });

// Q1: the trade as recorded at 10:00 on 3 March (system time)
var asRecorded = await db.Trades.TemporalAsOf(new DateTime(2026, 3, 3, 10, 0, 0, DateTimeKind.Utc))
    .SingleAsync(t => t.Id == tradeId, ct);

// Q2: what we believed on 3 March about terms effective 1 March (bitemporal)
var believed = await db.TradeTerms.TemporalAsOf(new DateTime(2026, 3, 3, 23, 59, 59, DateTimeKind.Utc))
    .Where(t => t.TradeId == tradeId && t.EffectiveFrom <= new DateOnly(2026, 3, 1)
             && (t.EffectiveTo == null || t.EffectiveTo > new DateOnly(2026, 3, 1)))
    .OrderByDescending(t => t.EffectiveFrom).FirstAsync(ct);

// Full change history with who and why (stamped by an interceptor)
var history = await db.Trades.TemporalAll().Where(t => t.Id == tradeId)
    .OrderBy(t => EF.Property<DateTime>(t, "SysStartUtc"))
    .Select(t => new { t.Quantity, t.Price, t.ModifiedBy, t.ChangeReason, From = EF.Property<DateTime>(t, "SysStartUtc") })
    .ToListAsync(ct);
~~~`,
  pts: [r`Separate system time from business time; question two is bitemporal.`, r`Temporal tables capture every version automatically; EF queries them with TemporalAsOf and friends.`, r`Business time is modelled with effective dates and supersession.`, r`Interceptors stamp who and why on every change.`, r`Plan retention, partitioning and tamper evidence for years of history.`],
  ex: r`A regulator's trade reconstruction request took a bank three weeks of log archaeology because history lived in application logs. After moving to temporal tables plus effective-dated terms and change-reason stamping, the same request was answered with two queries in an afternoon.`,
  fu: [r`How do you change the schema of a temporal table through EF migrations?`, r`What breaks AS OF query performance at scale?`, r`When would you add ledger tables on top of temporal tables?`],
  pit: [r`Claiming temporal tables are bitemporal.`, r`A soft-delete flag as the audit trail.`, r`Audit only in application logs.`] },

{ id: 'q44', level: 'Principal', tags: ['ef-core', 'migrations', 'deployment', 'governance'],
  q: r`How do EF Core migrations reach production in a regulated firm? Compare SQL scripts, migration bundles, CLI and runtime Migrate(), and cover identities, locking and review.`,
  a: r`### Options
| Approach | Strengths | Weaknesses |
|---|---|---|
| **Idempotent SQL script** ({{migrations script --idempotent}}) | reviewable, DBA- and change-board-friendly, applied by any tool | no EF lock, no seeding logic |
| **Migration bundle** ({{migrations bundle}} → {{efbundle}}) | self-contained executable for pipelines, EF migration lock, seeding | you cannot see the SQL it will run without generating a script separately |
| **CLI {{database update}}** | convenient | local development only |
| **Runtime {{Migrate()}}** at startup | zero setup | app needs DDL rights; races across replicas (EF 9 added a database lock but not review, rollback or privilege separation); a failed migration crash-loops every pod; EF 9+ throws on pending model changes |

### My design
- CI generates **both** a bundle and an idempotent script from the same commit.
- Non-production environments apply the **bundle** automatically.
- Production applies the **reviewed script**, verified by **hash** so the approved artefact is byte-identical to what runs; four-eyes approval; recorded in change management.
- **Two identities**: a deployment identity with DDL rights used only by the pipeline job; the runtime identity has DML only (and INSERT-only on append-only tables).
- Run as a **one-shot job** before the rollout, never in every replica's entrypoint; set the environment correctly ({{ASPNETCORE_ENVIRONMENT=Production}}) for bundles; pass the connection string from a secret store.

### Locking and safety
- Schema changes take **Sch-M locks**; behind a long-running transaction they wait and **everything else queues behind them**. Set {{LOCK_TIMEOUT}}, check for long transactions first, use online and resumable index operations.
- A **migration safety analyzer** in CI blocks drops, narrowing type changes and rename-as-drop-add without a waiver.
- {{dotnet ef migrations has-pending-model-changes}} fails the build when the model and migrations diverge.
- Never {{EnsureCreated}} before {{Migrate}}; never wrap {{Migrate}} in your own transaction.`,
  dia: r`flowchart LR
  A[Commit] --> B[CI: bundle + idempotent script + hash]
  B --> C[Safety analyzer and pending-model check]
  C --> D[Non-prod: run bundle job]
  D --> E[Tests on prod-sized copy]
  E --> F[Change approval of script hash]
  F --> G[Prod: deploy identity runs approved script]
  G --> H[Rollout app with DML-only identity]`,
  code: r`~~~yaml
# Pipeline excerpt
- name: Build migration artefacts
  run: |
    dotnet ef migrations has-pending-model-changes --project src/Payments.Data
    dotnet ef migrations script --idempotent -o artifacts/migrate.sql --project src/Payments.Data
    dotnet ef migrations bundle --self-contained -r linux-x64 -o artifacts/efbundle --project src/Payments.Data
    sha256sum artifacts/migrate.sql > artifacts/migrate.sql.sha256
    ./tools/migration-lint artifacts/migrate.sql --deny "DROP COLUMN,DROP TABLE,sp_rename" --require-waiver-file waivers.yml
- name: Apply to UAT (bundle, one-shot job)
  run: ./artifacts/efbundle --connection "$UAT_MIGRATION_CONN"
  env: { ASPNETCORE_ENVIRONMENT: Production }
- name: Apply to production (approved script only)
  run: |
    sha256sum -c artifacts/migrate.sql.sha256
    sqlcmd -S "$PROD_SQL" -d Payments -G -b -v LockTimeoutMs=5000 -i artifacts/migrate.sql
~~~
~~~sql
-- Guard at the top of large migrations
SET LOCK_TIMEOUT 5000;   -- fail instead of queueing every query behind a Sch-M wait
IF EXISTS (SELECT 1 FROM sys.dm_tran_active_transactions WHERE DATEDIFF(second, transaction_begin_time, SYSDATETIME()) > 60)
    THROW 51000, 'Long-running transaction present; migration aborted', 1;
~~~`,
  pts: [r`Scripts are reviewable; bundles automate; Migrate() at startup is for demos.`, r`Approve the script hash; run exactly that artefact in production.`, r`Separate deployment (DDL) and runtime (DML) identities.`, r`One-shot job before rollout; lock timeouts and online operations.`, r`CI gates: safety analyzer, pending-model-changes check.`],
  ex: r`A service ran Migrate() at startup; a migration adding a NOT NULL column with a default to a 300-million-row table on an older SQL Server version rebuilt the table, every pod's startup probe failed, and the rollout stalled for 50 minutes with the old pods drained. Moving to a pipeline job with lock timeouts and expand/contract made the next large change routine.`,
  fu: [r`What is your rollback story for a migration?`, r`How do you keep seed data idempotent?`, r`How do you migrate 300 tenant databases and track version skew?`],
  pit: [r`Runtime migration "because EF 9 has a lock".`, r`One identity for app and DDL.`, r`Applying a script different from the one reviewed.`] },

{ id: 'q45', level: 'Principal', tags: ['ef-core', 'zero-downtime', 'expand-contract', 'migrations'],
  q: r`EF generated DropColumn + AddColumn for a column rename on a 200-million-row table. What happens if you apply it, and how do you rename with zero downtime across rolling deployments?`,
  a: r`### What EF generated
EF "is generally unable to know" a rename from a drop plus an add. Applied as is, **all the data in that column is lost**. Scaffolding prints a data-loss warning, but that control lives on one developer's terminal; move it into CI.

### Why even a correct RenameColumn breaks production
During a rolling deployment **version N and N+1 run at the same time** (40 pods, 10 at a time, 90 seconds per wave is about 6 minutes, plus a rollback window of hours or days). Version N still reads the old name. The schema must serve **both versions** at every moment.

### Expand / contract
1. **Release 1 (expand)**: add the new column, nullable. Metadata-only, instant.
2. **Release 2 (dual write)**: the app writes both columns; reads the old one.
3. **Backfill** in batches, idempotent ({{WHERE NewCol IS NULL}}), throttled: 200 million rows in 5,000-row chunks is 40,000 chunks; at about 40 ms each that is roughly 27 minutes of database time, longer throttled.
4. **Release 3 (switch reads)** behind a feature flag; nightly parity check of old vs new.
5. **Release 4 (contract)**: stop writing the old column; drop it after the rollback window, with a waiver.
6. Optional: a computed column or view with the old name if external readers exist.

### The lock-queue trap
Every DDL step needs a **Sch-M lock**. If a long transaction holds a conflicting lock, the ALTER waits, and **every new query queues behind it**: a millisecond ALTER can stall the table for as long as the blocker runs (4,000 req/s x 28 s is 112,000 stalled requests). Use {{SET LOCK_TIMEOUT}}, check for long transactions, and retry later.

**Rollback** is a feature-flag flip or forward fix, not a {{Down}} migration (which often loses data).`,
  code: r`~~~csharp
// Release 1: expand (hand-edited migration replacing the generated drop/add)
public partial class AddBeneficiaryName : Migration
{
    protected override void Up(MigrationBuilder mb) =>
        mb.AddColumn<string>("BeneficiaryName", "Payments", maxLength: 140, nullable: true);
    protected override void Down(MigrationBuilder mb) => mb.DropColumn("BeneficiaryName", "Payments");
}

// Release 2: dual write in the entity
public void SetBeneficiary(string name) { PayeeName = name; BeneficiaryName = name; }

// Backfill job: batched, idempotent, throttled
while (true)
{
    var n = await db.Payments.Where(p => p.BeneficiaryName == null && p.PayeeName != null)
        .OrderBy(p => p.Id).Take(5_000)
        .ExecuteUpdateAsync(s => s.SetProperty(p => p.BeneficiaryName, p => p.PayeeName), ct);
    if (n == 0) break;
    await Task.Delay(200, ct);                  // leave headroom for OLTP and log backups
}

// Release 3: read behind a flag
var name = flags.IsEnabled("read-beneficiary-name") ? p.BeneficiaryName : p.PayeeName;

// Release 4 (after the rollback window, with waiver): stop writing and drop PayeeName
~~~`,
  pts: [r`Generated drop + add destroys data; move the warning into CI.`, r`Rolling deploys mean two app versions share one schema.`, r`Expand, dual write, batched backfill, switch reads behind a flag, contract later.`, r`Sch-M lock queues can stall a table: lock timeouts and long-transaction checks.`, r`Roll back with flags and forward fixes, not Down migrations.`],
  ex: r`A team applied an EF-generated rename on a payments table; the drop ran in UAT and wiped beneficiary names for 2 million test payments, which was only noticed because UAT data was a masked production copy. CI now fails any migration containing DropColumn without a waiver, and renames follow a four-release expand/contract template.`,
  fu: [r`How do you add an index to a 400-million-row table online?`, r`What CI rule would have caught this?`, r`How do you handle external consumers (reports, ETL) reading the old column?`],
  pit: [r`Trusting generated migrations.`, r`Adding a NOT NULL column without a default to a large table.`, r`Treating Down as a rollback plan.`] },

{ id: 'q46', level: 'Principal', tags: ['ef-core', 'incident', 'performance', 'query-store'],
  q: r`A release that only added one column made an endpoint's p99 go from 40 ms to 4 seconds. Walk through containment and layer-by-layer diagnosis.`,
  a: r`### Contain first
Roll back the app or flip the feature flag; check whether the migration itself is still running. Restore service, then diagnose.

### Metrics before logs
- EF meter: did {{compiled_query_cache_misses}} jump? did {{active_dbcontexts}} or pool waits rise? {{execution_strategy_operation_failures}}?
- Database: waits ({{LCK_M_*}}, {{PAGEIOLATCH}}, {{RESOURCE_SEMAPHORE}}), Query Store top consumers by tag.

### How one new column can do this
1. **Large column on a hot entity**: queries that load whole entities now fetch a big {{nvarchar(max)}} or JSON column: more I/O and memory grants. Fix with projections or move it to a side table.
2. **The migration itself**: a backfill or table rebuild still running, or a **Sch-M lock queue** ({{LCK_M_SCH_M}} chains) stalling the table.
3. **Plan cache flush and new statistics** after the schema change: recompiles pick a worse plan for the sniffed parameter. Compare plans in Query Store; force the old plan as a stopgap.
4. **Parameter type change**: the new mapping made a string nvarchar against a varchar column: {{CONVERT_IMPLICIT}} scan.
5. **Covering index no longer covers**: the endpoint's projection now includes the new column, so seeks gain key lookups for every row.

### Prove, then fix
Read the **actual execution plan** before and after; fix at the right layer (projection, index INCLUDE, mapping, plan forcing then a real fix). Add a **regression test** (SQL or parameter-type snapshot, command count) and a **Query Store plan-change alert** for the tagged query.

### The process question
**Why did staging not show it?** Usually because staging data is 1% of production. Answer with a production-shaped (masked) performance environment for data-access changes.`,
  code: r`~~~sql
-- Query Store: did the plan for the tagged query change?
SELECT q.query_id, p.plan_id, rs.avg_duration / 1000 AS avg_ms, rs.count_executions, p.last_execution_time
FROM sys.query_store_query_text qt
JOIN sys.query_store_query q ON q.query_text_id = qt.query_text_id
JOIN sys.query_store_plan p ON p.query_id = q.query_id
JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
WHERE qt.query_sql_text LIKE N'-- Statement.Recent%'
ORDER BY p.last_execution_time DESC;

EXEC sys.sp_query_store_force_plan @query_id = 4711, @plan_id = 12;   -- stopgap while fixing the root cause

-- Lock queue behind a schema change?
SELECT session_id, wait_type, wait_time, blocking_session_id FROM sys.dm_exec_requests WHERE wait_type LIKE 'LCK_M_SCH%';
~~~
~~~csharp
// Root-cause fix for case 1: project instead of loading entities with the new large column
var rows = await db.Statements.TagWith("Statement.Recent").AsNoTracking()
    .Where(s => s.AccountId == id).OrderByDescending(s => s.Id).Take(50)
    .Select(s => new StatementRow(s.Id, s.Amount, s.BookedUtc))      // excludes the new 40 KB RemittanceInfo column
    .ToListAsync(ct);

// Root-cause fix for case 5: index covers the projection again
migrationBuilder.Sql("CREATE INDEX IX_Statements_Account ON dbo.Statements (AccountId, Id DESC) INCLUDE (Amount, BookedUtc) WITH (ONLINE = ON, DROP_EXISTING = ON);");
~~~`,
  pts: [r`Contain first: roll back or flip the flag; check the migration.`, r`Metrics before logs: EF meter, waits, Query Store by tag.`, r`Five mechanisms: large column, migration locks, plan regression, type mismatch, lost coverage.`, r`Prove with actual plans; force a plan only as a stopgap.`, r`Ask why staging missed it: production-shaped data.`],
  ex: r`Adding a 40 KB RemittanceInfo column to Statements made the statement endpoint fetch it for 50 rows per page; memory grants and I/O spiked and p99 hit 4 s. A projection fixed it within the hour, and a rule that read endpoints must project caught two similar changes later.`,
  fu: [r`How do you build a production-scale performance environment cost-effectively?`, r`What alert would have caught this before customers did?`, r`When is plan forcing acceptable long-term?`],
  pit: [r`Jumping to "add an index".`, r`Optimising a query that did not change.`, r`No containment step.`] },

{ id: 'q47', level: 'Principal', tags: ['ef-core', 'observability', 'metrics', 'opentelemetry'],
  q: r`Design observability for a data-heavy EF Core service: what do you log, which metrics and traces do you collect, and what do you alert on?`,
  a: r`### Logging
- EF logs through {{ILogger}}; category {{Microsoft.EntityFrameworkCore.Database.Command}} at Information shows SQL with timings: on in development, sampled or Warning in production.
- **Never {{EnableSensitiveDataLogging}} in production** (parameter values are PII); add a startup guard. EF 10 also redacts inlined constants.
- {{ConfigureWarnings}} to **throw** on chosen events (multiple collection includes, collection without comparer, possible unintended client evaluation).

### Attribution
{{TagWith("Service.Class.Method")}} or {{TagWithCallSite()}} on every non-trivial query, so Query Store, APM and DMVs map to code.

### Metrics (EF 9+, meter {{Microsoft.EntityFrameworkCore}})
| Metric | Signals |
|---|---|
| {{active_dbcontexts}} | growth = context leak |
| {{queries}} per request | drift = N+1 |
| {{savechanges}} | write volume |
| {{compiled_query_cache_hits / misses}} | sustained misses = dynamic-query defect |
| {{execution_strategy_operation_failures}} | transient infrastructure trouble |
| {{optimistic_concurrency_failures}} | contention |

Plus SqlClient connection-pool metrics (active, idle, **pending requests / wait count**).

### Traces
{{OpenTelemetry.Instrumentation.SqlClient}} (or EF Core instrumentation) gives a span per command with duration and statement summary; correlate trace → tag → Query Store plan.

### Alerts (leading indicators first)
- Pool wait count > 0 for 60 s.
- Deadlocks per hour > 0.
- Compiled-query cache hit rate < 99% for 10 min.
- p99 per tagged critical query; Query Store plan change on critical queries.
- Oldest unpublished outbox message age.
- Optimistic concurrency failure rate.`,
  code: r`~~~csharp
builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        .AddMeter("Microsoft.EntityFrameworkCore")         // EF 9+ metrics
        .AddMeter("Microsoft.Data.SqlClient.EventSource")   // connection pool
        .AddAspNetCoreInstrumentation()
        .AddOtlpExporter())
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddSqlClientInstrumentation(o => o.SetDbStatementForText = true)
        .AddOtlpExporter());

builder.Services.AddDbContext<PaymentsDbContext>(o =>
{
    o.UseSqlServer(cs);
    o.ConfigureWarnings(w => w
        .Throw(RelationalEventId.MultipleCollectionIncludeWarning)
        .Throw(CoreEventId.CollectionWithoutComparer));
    if (builder.Environment.IsDevelopment()) o.EnableSensitiveDataLogging();
});

// Startup guard
if (!builder.Environment.IsDevelopment() && builder.Configuration.GetValue<bool>("EF:SensitiveLogging"))
    throw new InvalidOperationException("Sensitive data logging is not allowed outside development");

// Attribution on every non-trivial query
var page = await db.Payments.TagWithCallSite().TagWith("Payments.ListForMerchant")
    .Where(p => p.MerchantId == m).OrderByDescending(p => p.Id).Take(50).ToListAsync(ct);

// Older EF: dotnet-counters monitor --counters Microsoft.EntityFrameworkCore -p <pid>
~~~`,
  pts: [r`SQL logging in development; never sensitive logging in production (guard it).`, r`Tag every non-trivial query for attribution.`, r`EF 9+ meter: contexts, queries, cache hits, retries, concurrency failures.`, r`Traces per command correlated to tags and plans.`, r`Alert on leading indicators: pool waits, deadlocks, cache hit rate, plan changes, outbox age.`],
  ex: r`A cache-hit-rate alert (below 99% for 10 minutes) fired the day a new search feature shipped with Expression.Constant predicates; the team fixed it before SQL Server's plan cache filled up. Previously the same class of bug had only been found after a database CPU incident.`,
  fu: [r`How do you correlate an APM span to a Query Store plan?`, r`What does Information-level SQL logging cost in production?`, r`Which of these alerts would have caught the streaming-export incident?`],
  pit: [r`Only logging SQL.`, r`Sensitive data logging left on.`, r`Alerting only on timeouts (lagging).`] },

{ id: 'q48', level: 'Principal', tags: ['ef-core', 'security', 'multi-tenancy', 'compliance'],
  q: r`What security and multi-tenancy controls do you require for an EF Core service handling payments data? Cover injection, identities, encryption, over-posting, logging and the three tenancy models.`,
  a: r`### Injection
Interpolated {{FromSql}} / {{ExecuteSql}} are parameterised. **Never concatenate into the Raw methods**; EF 10's analyzer warning is configured as an error. Allow-list dynamic identifiers.

### Identities and secrets
- **Passwordless**: managed identity / Entra ID authentication; no passwords in config or bundles.
- **Separate deployment (DDL) and runtime (DML-only) identities**; INSERT-only on append-only tables; no {{db_owner}} for apps.

### Data protection
- TDE at rest; **Always Encrypted** for the few columns DBAs must not read (equality only with deterministic encryption; test batching and OUTPUT behaviour).
- App-level encryption via converters makes columns unqueryable; plan key rotation.
- **PCI**: never model a PAN; store tokens and last four.
- **GDPR**: soft delete is not erasure; use pseudonymisation or crypto-shredding (per-subject keys deleted), and remember history and temporal tables.

### Over-posting
DTOs per endpoint; never bind requests to entities; tenant and owner ids come from the **token**, never from the body or headers.

### Logging
No sensitive data logging in production (startup guard); scrub exception messages that include parameter values.

### Tenancy models
| Model | Isolation | Cost and operations |
|---|---|---|
| Shared schema + TenantId | filters + **RLS** via SESSION_CONTEXT on every connection open + write interceptor | cheapest; one migration; noisy neighbours |
| Schema per tenant | custom {{IModelCacheKeyFactory}} and schema per context | more objects; migrations per schema |
| Database per tenant | strongest; per-tenant restore and residency | **one ADO.NET pool per connection string**: connection budget grows with tenants; N databases to migrate; version skew tracking |

### Change control
Approved migration hash equals the applied artefact; four-eyes review; audited break-glass access.`,
  code: r`~~~csharp
// Passwordless connection
var cs = "Server=tcp:payments.database.windows.net;Database=Payments;Authentication=Active Directory Managed Identity;Encrypt=True";

// Fail the build on Raw SQL with interpolation (EF 10 analyzer) in .editorconfig:
// dotnet_diagnostic.EF1002.severity = error

// Tenant from the token only
public sealed class TenantAccessor(IHttpContextAccessor http) : ITenantAccessor
{
    public Guid? TenantId => Guid.TryParse(http.HttpContext?.User.FindFirst("tid")?.Value, out var t) ? t : null;
}

// Database-per-tenant: context per tenant connection, model shared
builder.Services.AddDbContextFactory<TenantDbContext>((sp, o) =>
    o.UseSqlServer(sp.GetRequiredService<ITenantDirectory>().ConnectionStringFor(sp.GetRequiredService<ITenantAccessor>().TenantId!.Value)));

// Schema-per-tenant: include the schema in the model cache key
public sealed class TenantModelCacheKeyFactory : IModelCacheKeyFactory
{
    public object Create(DbContext context, bool designTime) =>
        context is SchemaTenantDbContext t ? (context.GetType(), t.Schema, designTime) : (object)(context.GetType(), designTime);
}

// Crypto-shredding: per-subject key; erasure deletes the key, ciphertext becomes unreadable
modelBuilder.Entity<Customer>().Property(c => c.NationalId)
    .HasConversion(new SubjectKeyEncryptionConverter(keyStore));
~~~`,
  pts: [r`Interpolated SQL only; Raw-with-interpolation is a build error.`, r`Managed identities; separate DDL and DML identities.`, r`TDE, Always Encrypted, tokenised PANs, crypto-shredding for erasure.`, r`DTOs and token-derived tenant ids prevent over-posting and spoofing.`, r`Choose shared, schema or database per tenant by isolation vs operational cost.`],
  ex: r`A SaaS payments provider moved its largest 20 tenants to database-per-tenant for data-residency contracts while keeping 3,000 small tenants in a shared schema with RLS. The connection budget forced a per-tenant pool cap of 5 and a tenant-routing layer, which was planned rather than discovered in an outage.`,
  fu: [r`How does RLS behave with pooled connections serving tenants sequentially?`, r`How do you migrate 300 tenant databases and track skew?`, r`What does Always Encrypted break in EF Core queries?`],
  pit: [r`Filter-only tenant isolation.`, r`Secrets in appsettings or bundles.`, r`Soft delete presented as GDPR erasure.`] },

{ id: 'q49', level: 'Principal', tags: ['ef-core', 'upgrades', 'lifecycle', 'risk'],
  q: r`EF Core 8 and 9 reach end of support on 10 November 2026. Plan the move to EF Core 10 across your services, including what can change silently.`,
  a: r`### Facts
- EF Core 10 is **LTS**, supported to **10 November 2028**, and requires **.NET 10** (it does not run on .NET Framework).
- EF Core 8 and 9 both end support on **10 November 2026**.
- EF 11 is planned for November 2026: its features are **not design inputs** until released.

### Runbook
1. Upgrade **all Microsoft.EntityFrameworkCore.* packages together**; check **third-party providers** (Npgsql, Pomelo) and libraries (bulk extensions) for EF 10 versions.
2. Read the **breaking changes** for 9 and 10.
3. Run the full test suite on the **real engine**.
4. **Diff generated SQL** for critical queries (snapshot tests) and **add a migration against a production copy** to see what the model diff wants to change.
5. Load test; compare **compiled-query cache hit rate**, per-tagged-query p99 and **Query Store plans**.
6. Canary, then fleet rollout with an owner and a date per service.

### Silent changes to look for
- **Contains over collections** now translates to multiple padded parameters instead of one JSON parameter: SQL and plan shapes change for every such query.
- With {{UseAzureSql}} or compatibility level 170+, existing **nvarchar JSON columns migrate to the json type** on the next migration.
- Named default constraints ({{UseNamedDefaultConstraints}}) rename constraints if enabled.
- From EF 9: migration **locking**, and {{Migrate()}} **throwing on pending model changes**.
- EF 10 **reverted** EF 9's single transaction across all migrations.
- New analyzer warnings (Raw SQL with interpolation) that may become build errors.

### Rollback
Keep the previous release deployable; migrations created during the upgrade must be backward compatible (expand only) so the app can roll back without a schema rollback.`,
  code: r`~~~xml
<!-- Directory.Packages.props: one version for the whole family -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.0" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.0" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.0" />
</ItemGroup>
~~~
~~~csharp
// SQL snapshot test: fails when generated SQL changes, forcing a conscious review
[Fact]
public Task Payment_search_sql_is_stable()
{
    using var db = TestDb.Create();
    var sql = PaymentQueries.Search(db, new PaymentFilter { MerchantIds = [1, 2, 3], MinAmount = 100 }).ToQueryString();
    return Verify(sql);      // Verify snapshot; review diffs during the upgrade
}

// Pin behaviours you are not ready to change yet
options.UseSqlServer(cs, sql => sql.UseParameterizedCollectionMode(ParameterTranslationMode.Parameter));   // keep EF 8/9 OPENJSON shape
modelBuilder.Entity<GatewayLog>().Property(g => g.Payload).HasColumnType("nvarchar(max)");                   // no automatic json type change
~~~`,
  pts: [r`EF 10 is LTS to Nov 2028 and needs .NET 10; EF 8/9 end Nov 2026.`, r`Upgrade the whole package family and providers together.`, r`Diff SQL, plans and migrations on production-shaped data.`, r`Watch Contains translation, JSON column type changes, migration behaviour.`, r`Pin behaviours you are not ready for; keep rollback possible with expand-only migrations.`],
  ex: r`A pilot service upgraded to EF 10 and its nightly migration attempted to convert three nvarchar JSON columns to json on a 2 TB Azure SQL database. The migration review caught it; the columns were pinned and converted later in a planned window.`,
  fu: [r`How do you schedule upgrades across 30 services with different owners?`, r`What would you do if a third-party provider has no EF 10 release yet?`, r`Which upgrade checks belong in CI permanently?`],
  pit: [r`Treating it as a package bump.`, r`"No compile errors means no changes".`, r`Designing around unreleased EF 11 features.`] },

{ id: 'q50', level: 'Principal', tags: ['ef-core', 'leadership', 'governance', 'platform'],
  q: r`You now own EF Core across 30 services and 15 teams. What do you put in place (platform, gates, tests, standards), and how do you roll it out?`,
  a: r`Encode rules **structurally** (code, tests, gates), not as wiki pages.

### Paved road
- A platform package: {{AddPlatformDbContext<T>()}} wiring the provider, a tightened retry budget, a **capacity-derived pool size**, interceptors (audit, tenant guard, outbox, RLS session context), health checks, OpenTelemetry, warnings-as-errors.
- Workers receive an {{IUnitOfWorkFactory}}, never a raw DbContext; an analyzer flags DbContext injected into singletons; {{ValidateScopes}} / {{ValidateOnBuild}} enforced by a test.

### Model rules as tests
No unbounded strings; no default decimal(18,2); comparer on every mutable converter; explicit delete behaviour (no cascades on financial tables); required-navigation-to-filtered-entity check; {{IsUnicode}} matches the catalog.

### Migration pipeline
Safety analyzer (drops, narrowing, rename-as-drop-add need waivers), expand/contract template for large tables, idempotent script with **hash approval**, two identities, {{LOCK_TIMEOUT}}, {{has-pending-model-changes}}, schema drift detection.

### Testing standard
Real engine via Testcontainers, migrations applied, Respawn; concurrency tests for money paths; command-count and SQL snapshot tests for critical queries.

### Observability standard
Tags on every non-trivial query, the EF metrics, pool-wait alerts, Query Store plan-change alerts on critical queries, outbox age.

### Lifecycle
An **upgrade runbook** with a dated owner per service (EF 8/9 end of support 10 November 2026); waivers carry owners and **expiry dates**.

### Review checklist
Projection or no-tracking on reads; no N+1 (count test); split vs single chosen; keyset paging; ExecuteUpdate not mixed with tracked writes; concurrency token or guarded statement; idempotency key; canonical lock order; outbox for events; no IgnoreQueryFilters outside the reporting context; no sensitive logging.

### Rollout
Order by risk: **silent cross-tenant leaks** and money correctness first, then performance. Pilot with two willing teams, publish before/after numbers, make the paved road the easiest path, and measure success by **incident classes eliminated**, not documents written.`,
  code: r`~~~csharp
public static class PlatformDataExtensions
{
    public static IServiceCollection AddPlatformDbContext<TContext>(this IServiceCollection services, IConfiguration cfg, string name)
        where TContext : DbContext
    {
        var cs = PoolBudget.Apply(cfg.GetConnectionString(name)!, cfg.GetValue<int>("Platform:PodCount"));   // capacity-derived Max Pool Size
        services.AddScoped<AuditInterceptor>().AddScoped<TenantWriteGuard>().AddScoped<OutboxInterceptor>().AddScoped<TenantSessionContext>();
        services.AddDbContextFactory<TContext>((sp, o) => o
            .UseSqlServer(cs, sql => sql.EnableRetryOnFailure(3, TimeSpan.FromSeconds(5), [1205]))
            .AddInterceptors(sp.GetRequiredService<AuditInterceptor>(), sp.GetRequiredService<TenantWriteGuard>(),
                             sp.GetRequiredService<OutboxInterceptor>(), sp.GetRequiredService<TenantSessionContext>())
            .ConfigureWarnings(w => w.Throw(RelationalEventId.MultipleCollectionIncludeWarning, CoreEventId.CollectionWithoutComparer)),
            ServiceLifetime.Scoped);
        services.AddScoped(sp => sp.GetRequiredService<IDbContextFactory<TContext>>().CreateDbContext());
        services.AddScoped<IUnitOfWorkFactory<TContext>, UnitOfWorkFactory<TContext>>();
        services.AddHealthChecks().AddDbContextCheck<TContext>();
        return services;
    }
}

// Shipped test kit every service runs
public abstract class PlatformModelRules<TContext>(Func<TContext> create) where TContext : DbContext
{
    [Fact] public void No_unbounded_strings() => ModelRules.AssertNoUnboundedStrings(create());
    [Fact] public void No_default_decimal_precision() => ModelRules.AssertExplicitDecimalPrecision(create());
    [Fact] public void No_cascade_on_financial_tables() => ModelRules.AssertNoCascades(create(), tag: "financial");
    [Fact] public void Mutable_converters_have_comparers() => ModelRules.AssertComparers(create());
}
~~~`,
  pts: [r`Encode rules as code, tests and gates, not documents.`, r`Platform package wires pool budget, retries, interceptors, telemetry and warnings.`, r`Model rules, migration gates and real-engine tests ship as a kit.`, r`Dated upgrade owners; waivers with expiry.`, r`Roll out by risk; measure incident classes eliminated.`],
  ex: r`At a payments group with 34 services, a platform data package plus a shared test kit was adopted by all teams in two quarters. Cross-tenant data incidents went from three a year to zero, migration-related outages from five to one, and the EF 8 to 10 upgrade finished three months before end of support.`,
  fu: [r`How do you roll this out without a big-bang mandate?`, r`What is your first quarter's priority order?`, r`How do you handle a team that needs an exception to the paved road?`],
  pit: [r`A wiki page of guidelines with no enforcement.`, r`Gatekeeping instead of a paved road.`, r`No owner for upgrades.`] }
],
cheat: r`### LINQ
IQueryable = expression tree translated by the provider; IEnumerable = delegates in memory. Deferred until enumerated; enumerate twice = run twice. AsEnumerable/ToList before filtering loads everything. ToLookup once, not GroupBy in loops. Any() not Count() > 0. .NET 6: DistinctBy, MaxBy, Chunk. .NET 9: CountBy, AggregateBy, Index. .NET 10: LeftJoin/RightJoin. Static lambdas avoid closures; validate iterator arguments eagerly.

### DbContext
| Rule | Why |
|---|---|
| Scoped, one unit of work | tracker memory, stale identity map, DetectChanges cost |
| One operation at a time | not thread-safe, async included |
| Factory for workers, Blazor, parallel | unit of work is not the request |
| Pool only when profiled | per-request state leaks across leases |
| ValidateScopes + ValidateOnBuild | catch captive contexts |

### Reads
Projection to DTOs (no tracking, only needed columns) → AsNoTracking → AsNoTrackingWithIdentityResolution for read-only graphs. N+1: projection / Include / batched loads; command-count tests. Sibling collection Includes = cartesian product → AsSplitQuery (no consistency without snapshot). Keyset paging with unique tiebreaker, k+1 fetch, signed cursor. Streaming holds the connection: chunk exports, separate pool.

### Writes
| Topic | Rule |
|---|---|
| SaveChanges | DetectChanges → interceptors → FK order → batch + OUTPUT → one txn → accept; after failure tracker still dirty |
| Update(dto) | overwrites all columns, over-posting; load → domain method → save |
| Concurrency | rowversion; 0 rows → DbUpdateConcurrencyException; 412 for humans, retry unit for jobs |
| Balance invariant | guarded ExecuteUpdate WHERE Balance >= @amt; rows affected = outcome |
| ExecuteUpdate | tracker unaware, no txn, no token, no interceptors, ExecuteDelete is a real delete |
| Bulk | AddRange (10^4) → chunk + Clear (10^5) → SqlBulkCopy + staging + MERGE |
| Retries | EnableRetryOnFailure buffers results; user txn inside strategy.ExecuteAsync; idempotency key for commit ambiguity |
| Deadlock 1205 | canonical lock order, short txn, retry unit with fresh context |
| Events | outbox rows via interceptor; relay UPDLOCK READPAST; consumers dedupe |

### Modeling
Fluent > annotations > conventions; ConfigureConventions: string length, decimal(19,4), UTC. Money = complex type (amount + currency). Keys: bigint sequence/HiLo + unique idempotency key; SQL Server sorts GUIDs by last bytes. Delete: Restrict for financial data. TPH + CHECK per discriminator; TPC loses FK to base. Mutable converters need ValueComparer. JSON for owner-scoped blobs, never for queried fields. Query filters are not security: RLS + write guard; EF 10 named filters.

### Performance order
SQL/indexes/implicit conversions → round trips/N+1/over-fetch → tracking/projection → pooling/compiled queries (single-digit %). nvarchar param vs varchar column = CONVERT_IMPLICIT scan → IsUnicode(false). Contains: EF 8/9 OPENJSON, EF 10 padded params, 2,100-param limit → chunk/TVP.

### Production
Migrations: idempotent script (hash-approved) for prod, bundle for non-prod, never Migrate() at startup; DDL vs DML identities; LOCK_TIMEOUT. Rename = expand/contract over 4 releases. Testing: Testcontainers + real migrations + Respawn; not InMemory. Metrics (EF 9+): active_dbcontexts, queries, cache hits/misses, retries, concurrency failures; alert on pool waits. EF 10 LTS to Nov 2028 needs .NET 10; EF 8/9 end 10 Nov 2026.

### Pool sizing
L = λ·W (6,000/s × 4 ms = 24). SQL Server workers at 16 CPU = 704. Cap per pod ≈ 0.7 × 704 / pods; short Connect Timeout; 503 + Retry-After.`
});
})(String.raw);
