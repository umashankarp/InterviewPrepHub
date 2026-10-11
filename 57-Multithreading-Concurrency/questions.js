(function (r) {
registerTopic('57-multithreading-concurrency', {
related: ['01-csharp', '02-dotnet-aspnetcore', '16-distributed-systems'],
questions: [
{ id: 'q1', level: 'Basic', tags: ['threads', 'tasks', 'async', 'fundamentals'],
  q: r`Process, thread, thread-pool thread, Task and async method: what is each mechanically, what does a thread cost, and why does an awaited I/O call not occupy a thread?`,
  a: r`### The layers
| Concept | What it is |
|---|---|
| **Process** | isolated address space, handles, at least one thread |
| **OS thread** | a schedulable unit: its own **stack** (1 MB reserved by default on Windows, 8 MB on Linux, committed as used), registers, kernel object; scheduled pre-emptively by the OS |
| **Thread-pool thread** | an OS thread owned by the .NET thread pool, reused for many work items |
| **Task** | a **promise** of a future result plus continuations; *not* a thread. It may represent CPU work queued to the pool or an I/O operation with no thread at all |
| **async method** | compiled into a **state machine**; each {{await}} on an incomplete task registers the rest of the method as a continuation and **returns** |

### What a thread costs
Memory for the stack, kernel structures, creation time (tens to hundreds of microseconds), and **context switches** (microseconds each, plus cache pollution). Thousands of threads mostly blocked on I/O waste memory and CPU on switching: that is why "one thread per request, blocking" does not scale.

### "There is no thread"
When you {{await}} a socket read, the OS starts the I/O and the method returns; no .NET thread waits. When the network card completes, the OS signals an **I/O completion port** (Windows) or **epoll** (Linux); a pool thread runs the continuation. 10,000 concurrent HTTP calls can be in flight with a handful of threads.

### CPU-bound vs I/O-bound
- I/O-bound: use **async** all the way; never block on it.
- CPU-bound: run on the pool ({{Task.Run}} or {{Parallel}}) only when it would otherwise block a thread that must stay responsive (UI) or to parallelise; in ASP.NET Core, a request is already on a pool thread, so {{Task.Run}} for CPU work just adds a hop.`,
  code: r`~~~csharp
// I/O-bound: no thread is blocked while the request is in flight
public async Task<decimal> GetFxRateAsync(string pair, CancellationToken ct)
{
    using var resp = await http.GetAsync($"/rates/{pair}", ct);   // method returns here; continuation runs later on a pool thread
    resp.EnsureSuccessStatusCode();
    return (await resp.Content.ReadFromJsonAsync<RateDto>(ct))!.Rate;
}

// Blocking version: holds a pool thread for the entire network wait
public decimal GetFxRateBlocking(string pair) =>
    http.GetFromJsonAsync<RateDto>($"/rates/{pair}").Result!.Rate;      // sync-over-async: wastes a thread, risks starvation

// CPU-bound fan-out: use the pool's worker threads
var risk = await Task.Run(() => MonteCarlo.Simulate(portfolio, paths: 100_000), ct);

// How many threads does the process really use?
Console.WriteLine($"Threads: {Process.GetCurrentProcess().Threads.Count}, pool: {ThreadPool.ThreadCount}, pending: {ThreadPool.PendingWorkItemCount}");
~~~`,
  pts: [r`Thread = OS scheduling unit with its own stack; Task = promise; async method = state machine.`, r`Threads cost memory, creation time and context switches.`, r`Awaited I/O holds no thread: completion ports or epoll wake a pool thread later.`, r`Async for I/O-bound work; pool threads or Parallel for CPU-bound work.`, r`Task.Run in ASP.NET Core request code usually adds a hop and nothing else.`],
  ex: r`A legacy WCF pricing service used a blocking thread per request and capped at 400 concurrent requests with 450 threads and 30% CPU spent context switching. The async rewrite served 5,000 concurrent requests with about 40 threads.`,
  fu: [r`What happens to the thread when an await hits an already-completed task?`, r`Why is a 1 MB stack reservation not 1 MB of RAM?`, r`When is Task.Run appropriate inside ASP.NET Core?`],
  pit: [r`Saying a Task is a thread.`, r`Task.Run around async I/O "to make it async".`, r`Blocking on .Result in server code.`] },

{ id: 'q2', level: 'Basic', tags: ['race-conditions', 'atomicity', 'visibility', 'interlocked'],
  q: r`Explain race conditions precisely: why is count++ not atomic, what are check-then-act and read-modify-write races, and what is the difference between atomicity, visibility and ordering?`,
  a: r`### count++ is three operations
Load the value, add one, store it. Two threads can both load 41 and both store 42: one increment is **lost**. No exception, just wrong numbers, more often under load and on more cores.

### Race shapes
| Shape | Example | Fix |
|---|---|---|
| **Read-modify-write** | {{balance -= amount}}, {{count++}} | {{Interlocked}}, lock, atomic DB statement |
| **Check-then-act** | {{if (!dict.ContainsKey(k)) dict.Add(k, v)}}; {{if (balance >= x) debit}} | one atomic operation ({{TryAdd}}, {{GetOrAdd}}, guarded UPDATE) or lock both steps |
| **Lazy initialisation** | two threads both create the singleton | {{Lazy<T>}}, static initialisers |
| **Publication** | a reference published before the object is fully constructed is seen half-initialised | publish via volatile/Interlocked or a lock |
| **Iteration during mutation** | {{foreach}} over a {{List}} another thread adds to | snapshot or concurrent/immutable collection |

### Three separate guarantees
- **Atomicity**: the operation happens all at once or not at all (no torn or lost updates). Reads and writes of references and of primitives up to the native word size (int, and long on 64-bit) are atomic; {{decimal}}, {{Guid}} and structs are **not** (torn reads).
- **Visibility**: a write on one core becomes visible to other cores; without synchronisation a loop can keep reading a cached value forever.
- **Ordering**: the compiler, JIT and CPU may reorder memory operations; another thread can observe them in a different order than the source code.

A {{lock}} gives all three for the code inside it. {{Interlocked}} gives atomicity and a full fence for one variable. {{volatile}} gives visibility and some ordering, **not** atomicity of compound operations.`,
  code: r`~~~csharp
// Lost updates: expected 1,000,000, typically prints less on a multi-core machine
int count = 0;
Parallel.For(0, 1_000_000, _ => count++);
Console.WriteLine(count);

// Atomic increment
int safe = 0;
Parallel.For(0, 1_000_000, _ => Interlocked.Increment(ref safe));   // always 1,000,000

// Check-then-act race and its atomic replacement
var cache = new ConcurrentDictionary<string, Rate>();
if (!cache.ContainsKey(pair)) cache[pair] = Load(pair);              // race: two loads, last write wins
var rate = cache.GetOrAdd(pair, Load);                                // atomic insert (factory may still run twice)

// Torn read: decimal is 16 bytes, not atomic
decimal balance;                                                      // a reader can see half of an old and half of a new value
private readonly object _gate = new();
public decimal Balance { get { lock (_gate) return balance; } }

// Visibility: without volatile, the JIT may hoist the read and loop forever
private volatile bool _stop;
void Worker() { while (!_stop) DoWork(); }
~~~`,
  pts: [r`count++ is load, add, store: concurrent increments get lost.`, r`Read-modify-write and check-then-act are the two common race shapes.`, r`Atomicity, visibility and ordering are separate guarantees.`, r`decimal, Guid and structs can tear; word-sized values and references do not.`, r`lock gives all three; Interlocked for single variables; volatile is not atomicity.`],
  ex: r`A card-transaction counter used for velocity rules (count++ on a shared field) undercounted by about 3% at peak, letting fraud bursts slip below the threshold. Interlocked.Increment, and later a per-card atomic counter in Redis, fixed it.`,
  fu: [r`Why does the lost-update bug appear more on servers than on laptops?`, r`Is reading a long atomic on a 32-bit process?`, r`How does a database guarded UPDATE solve check-then-act across processes?`],
  pit: [r`Assuming volatile makes ++ atomic.`, r`Reading a decimal shared field without synchronisation.`, r`"It passed the tests" for code with races.`] },

{ id: 'q3', level: 'Basic', tags: ['lock', 'monitor', 'synchronization'],
  q: r`How does lock work in .NET (Monitor, thin locks, sync blocks, reentrancy)? What should you lock on, what is the new System.Threading.Lock type in .NET 9, and why can you not await inside a lock?`,
  a: r`### Mechanics
A {{lock (obj)}} block compiles to {{Monitor.Enter(obj, ref taken)}} / {{try}} / {{finally Monitor.Exit(obj)}}.
- Uncontended: a **thin lock** stored in the object header (owner thread id plus recursion count), taken with one interlocked operation: tens of nanoseconds.
- Contended: the runtime **spins** briefly, then inflates to a **sync block** with a kernel wait object and blocks the thread.
- **Reentrant**: the owning thread can take it again (recursion count).
- Gives mutual exclusion **and** full memory fences on entry and exit, so writes inside are visible to the next owner.

### What to lock on
A **private readonly object** dedicated to the purpose. Never {{this}}, a {{Type}} ({{typeof(X)}}), or a **string** (interned strings are shared across the whole process): external code can lock the same object and deadlock you. Never a value type (boxing creates a new object each time, so nothing is locked).

### System.Threading.Lock (.NET 9, C# 13)
A dedicated lock type: {{private readonly Lock _gate = new();}}; the {{lock}} statement uses {{_gate.EnterScope()}}. Faster and clearer than Monitor on an arbitrary object, and the compiler warns if a Lock is accidentally used as a plain object.

### No await inside lock
The compiler forbids {{await}} in a lock body because Monitor is **thread-affine**: the continuation may resume on a different thread, which then calls Exit on a lock it does not own. Holding a lock across I/O would also block every other thread for the I/O duration. For async critical sections use {{SemaphoreSlim(1, 1)}} with {{WaitAsync}}.

### Rules
Keep critical sections **short**, with no I/O, no callbacks into unknown code, and no taking a second lock unless the order is fixed.`,
  code: r`~~~csharp
public sealed class ExposureBook
{
    private readonly Lock _gate = new();                  // .NET 9; use 'private readonly object _gate = new();' before
    private readonly Dictionary<string, decimal> _byCounterparty = new();

    public void Add(string counterparty, decimal amount)
    {
        lock (_gate)                                       // short, no I/O, no callbacks
        {
            _byCounterparty[counterparty] = _byCounterparty.GetValueOrDefault(counterparty) + amount;
        }
    }

    public IReadOnlyDictionary<string, decimal> Snapshot()
    {
        lock (_gate) return new Dictionary<string, decimal>(_byCounterparty);   // copy out, iterate outside the lock
    }
}

// What lock compiles to (Monitor version)
bool taken = false;
try { Monitor.Enter(_obj, ref taken); /* critical section */ }
finally { if (taken) Monitor.Exit(_obj); }

// Async critical section
private readonly SemaphoreSlim _mutex = new(1, 1);
public async Task RefreshAsync(CancellationToken ct)
{
    await _mutex.WaitAsync(ct);
    try { _token = await idp.GetTokenAsync(ct); }
    finally { _mutex.Release(); }
}

// Never: lock (this), lock (typeof(ExposureBook)), lock ("rates")
~~~`,
  pts: [r`lock = Monitor.Enter/Exit in try/finally; thin lock, spin, then sync block.`, r`Reentrant, and provides full memory fences.`, r`Lock on a private readonly object or the .NET 9 Lock type; never this, types or strings.`, r`No await inside lock: Monitor is thread-affine; use SemaphoreSlim for async.`, r`Short critical sections, no I/O, no unknown callbacks.`],
  ex: r`A pricing library locked on typeof(PriceCache); a plugin in the same process also locked on that type while calling back into the cache from another thread, and the service deadlocked weekly under load. A private lock object removed the deadlock.`,
  fu: [r`What happens if code inside lock throws?`, r`Why is lock reentrancy sometimes a hazard rather than a help?`, r`How expensive is an uncontended lock vs a contended one?`],
  pit: [r`lock(this) or lock on a string.`, r`I/O or awaits while holding a lock.`, r`Iterating a shared collection outside the lock that protects it.`] },

{ id: 'q4', level: 'Basic', tags: ['thread-safety', 'collections', 'bcl'],
  q: r`Which common .NET types are thread-safe and which are not (Dictionary, List, HttpClient, DbContext, Random, StringBuilder, static fields, DI singletons)? What happens when you share a non-thread-safe one?`,
  a: r`### The default contract
.NET documentation says "public static members are thread-safe; **instance members are not guaranteed**". Assume an instance is **not** safe for concurrent writes unless documented. Concurrent **reads** of a collection that nobody mutates are safe.

| Type | Concurrent use |
|---|---|
| {{Dictionary<K,V>}}, {{List<T>}}, {{HashSet<T>}}, {{Queue<T>}} | reads only. A concurrent write can **corrupt** internal state: lost items, exceptions, or a Dictionary stuck in an **infinite loop** (100% CPU) on a corrupted bucket chain |
| {{ConcurrentDictionary}}, {{ConcurrentQueue}}, {{Channel<T>}} | safe |
| Immutable / frozen collections | safe for reads; "changes" create new instances |
| {{HttpClient}} | safe for concurrent requests (do not change {{DefaultRequestHeaders}} concurrently) |
| {{DbContext}} | **not** safe; one operation at a time |
| {{Random}} instance | not safe: concurrent use can make it return **0 forever**; use {{Random.Shared}} (.NET 6+) |
| {{StringBuilder}}, {{MemoryStream}} | not safe |
| {{Regex}} instance | safe for matching |
| {{ILogger}}, {{IOptionsMonitor}} | safe |
| {{JsonSerializerOptions}} | safe once used (becomes read-only) |

### Where sharing happens without anyone noticing
- **Static fields** (caches, counters) in any class.
- **Singleton** services in DI: every request uses the same instance concurrently, so their fields must be thread-safe or immutable.
- Captured variables in lambdas passed to {{Parallel.ForEach}} or {{Task.WhenAll}}.
- Event handlers and timers firing on pool threads.

### Strategies, in order of preference
1. **Don't share**: per-request or per-task instances.
2. **Immutable** data published once.
3. **Concurrent collections** for shared mutable state.
4. **Locks** around compound operations.`,
  code: r`~~~csharp
// Corruption risk: singleton with a plain Dictionary written by concurrent requests
public sealed class BinCache                                  // registered as singleton
{
    private readonly Dictionary<string, BinInfo> _cache = new();     // concurrent writes can corrupt and hang
    public BinInfo Get(string bin) => _cache.TryGetValue(bin, out var b) ? b : (_cache[bin] = Lookup(bin));
}

// Fixed: concurrent collection (or immutable snapshot reloaded periodically)
public sealed class SafeBinCache
{
    private readonly ConcurrentDictionary<string, BinInfo> _cache = new();
    public BinInfo Get(string bin) => _cache.GetOrAdd(bin, Lookup);
}

// Random: shared instance is not safe
private static readonly Random Rng = new();                // concurrent Next() can degrade to returning 0
var jitter = Random.Shared.Next(50, 250);                  // thread-safe

// HttpClient: share it, but set per-request headers on the request, not on DefaultRequestHeaders
using var req = new HttpRequestMessage(HttpMethod.Get, "/accounts");
req.Headers.Authorization = new("Bearer", token);
var resp = await http.SendAsync(req, ct);
~~~`,
  pts: [r`Instance members are not thread-safe unless documented.`, r`Concurrent writes to Dictionary can corrupt it and spin a CPU forever.`, r`HttpClient, ConcurrentDictionary, Regex, ILogger are safe; DbContext, Random, StringBuilder are not.`, r`Static fields and DI singletons are shared by every request.`, r`Prefer not sharing, then immutability, then concurrent collections, then locks.`],
  ex: r`A BIN-lookup singleton used a plain Dictionary; once a month a pod pinned one core at 100% and request latency doubled. A dump showed threads looping inside Dictionary.FindValue on a corrupted chain. ConcurrentDictionary fixed it; an analyzer rule now flags mutable collections in singletons.`,
  fu: [r`Why can a corrupted Dictionary loop forever rather than throw?`, r`How do you find mutable state in singletons across a large codebase?`, r`Is reading a List<T> while another thread adds to it safe?`],
  pit: [r`Plain collections in singleton services.`, r`A shared Random instance.`, r`Mutating HttpClient.DefaultRequestHeaders per request.`] },

{ id: 'q5', level: 'Basic', tags: ['threads', 'thread-pool', 'task-run', 'long-running'],
  q: r`new Thread vs ThreadPool.QueueUserWorkItem vs Task.Run vs Task.Factory.StartNew(LongRunning): what does each do, when is a dedicated thread right, and what are the traps (foreground threads, StartNew with async lambdas)?`,
  a: r`| API | What it does | Use for |
|---|---|---|
| {{new Thread(...)}} | creates a dedicated OS thread | rare: long-lived loops needing a dedicated thread, specific priority, STA apartment, thread affinity |
| {{ThreadPool.QueueUserWorkItem}} | queues a delegate to the pool | low-level fire-and-forget; no Task, no exception propagation |
| {{Task.Run(...)}} | queues to the pool with sensible defaults; **unwraps** async lambdas | the default for CPU work off the current thread |
| {{Task.Factory.StartNew(..., TaskCreationOptions.LongRunning)}} | hints the scheduler to create a **dedicated thread** | a long blocking loop that would otherwise occupy a pool thread for hours |

### Traps
- **StartNew with an async lambda** returns {{Task<Task>}}; awaiting the outer task completes at the lambda's first await, not at the end. Use {{Task.Run}} (which unwraps) or {{.Unwrap()}}.
- **LongRunning with an async loop is pointless**: at the first await the dedicated thread is released and the rest runs on the pool. LongRunning only helps code that **blocks**.
- {{StartNew}} uses {{TaskScheduler.Current}}, which can be a UI or custom scheduler; {{Task.Run}} always uses the default scheduler.
- **Foreground vs background**: threads from {{new Thread}} are foreground by default and **keep the process alive** at shutdown; set {{IsBackground = true}} or make the thread observe a shutdown signal. Pool threads are background.
- Exceptions on a raw {{Thread}} crash the process; exceptions in a Task are stored in the Task (and lost if nobody observes it).

### In hosted services
Prefer {{BackgroundService}} with an async loop. If a library forces blocking calls in a loop (a legacy queue client), use a dedicated thread or LongRunning task so the pool is not starved.`,
  code: r`~~~csharp
// CPU work off the current thread
var result = await Task.Run(() => Pricing.Revalue(book), ct);

// Trap: StartNew + async lambda = Task<Task>; await completes too early
var wrong = Task.Factory.StartNew(async () => { await Task.Delay(1000); Console.WriteLine("done"); });
await wrong;                                  // returns after ~0 ms
await Task.Run(async () => { await Task.Delay(1000); Console.WriteLine("done"); });   // waits 1 s

// Legitimate dedicated thread: blocking receive loop from a legacy native client
var listener = new Thread(() =>
{
    while (!stopping.IsCancellationRequested)
    {
        var msg = legacyMqClient.Receive(TimeSpan.FromSeconds(1));   // blocking API
        if (msg is not null) channel.Writer.TryWrite(msg);           // hand off to async consumers
    }
})
{ IsBackground = true, Name = "mq-listener" };                       // do not block process exit
listener.Start();

// LongRunning equivalent (same idea, Task-based)
var loop = Task.Factory.StartNew(BlockingLoop, stopping.Token, TaskCreationOptions.LongRunning, TaskScheduler.Default);
~~~`,
  pts: [r`Task.Run is the default for CPU work; it unwraps async lambdas.`, r`StartNew with async lambdas returns Task<Task>.`, r`LongRunning helps only blocking loops, not async ones.`, r`new Thread is foreground by default: set IsBackground or handle shutdown.`, r`Dedicated threads for blocking legacy APIs; hand off to async code via channels.`],
  ex: r`A service started its consumer with Task.Factory.StartNew(async () => ...) and awaited it during shutdown; shutdown returned immediately while messages were still being processed, and Kubernetes killed pods mid-message. Switching to Task.Run (unwrapped) made graceful shutdown wait correctly.`,
  fu: [r`What is TaskScheduler.Current inside a UI event handler?`, r`How does the pool react when you block 50 pool threads in loops?`, r`Why does an unhandled exception on a raw Thread crash the process?`],
  pit: [r`StartNew with async lambdas.`, r`LongRunning for async loops.`, r`Foreground threads preventing shutdown.`] },

{ id: 'q6', level: 'Basic', tags: ['deadlocks', 'lock-ordering', 'liveness'],
  q: r`What conditions are required for a deadlock, how do lock-ordering deadlocks happen in .NET code, and what are the standard ways to prevent them? Also distinguish livelock and starvation.`,
  a: r`### The four Coffman conditions (all must hold)
1. **Mutual exclusion**: a resource is held exclusively.
2. **Hold and wait**: a thread holds one resource while waiting for another.
3. **No pre-emption**: resources cannot be taken away.
4. **Circular wait**: a cycle of threads each waiting for the next.
Break any one and deadlock is impossible.

### Typical .NET deadlocks
- **Lock ordering**: transfer A→B locks A then B; B→A locks B then A.
- **Callbacks under a lock**: raising an event or calling an injected delegate while holding a lock; the callee takes another lock or calls back in.
- **Sync-over-async** with a single-threaded context: {{.Result}} blocks the only thread the continuation needs (classic UI / old ASP.NET deadlock).
- **Thread-pool deadlock**: all pool threads blocked waiting for work items queued behind them.
- **Database + application locks**: holding a .NET lock while waiting for a database lock another thread holds while waiting for the .NET lock.

### Prevention
- **Global lock order**: always acquire in a canonical order (by id, by a rank number).
- **Never call unknown code while holding a lock**; copy state out, release, then call.
- **Timeouts**: {{Monitor.TryEnter(obj, timeout)}} or {{SemaphoreSlim.WaitAsync(timeout)}} turn a hang into a detectable error.
- **Fewer locks**: one coarse lock is often safer than several fine ones; or remove sharing (immutability, single owner).
- Async all the way, no {{.Result}}.

### Livelock and starvation
- **Livelock**: threads keep reacting to each other and make no progress (two retry loops backing off in lockstep). Add jitter.
- **Starvation**: a thread never gets the resource (writer starvation under a stream of readers, low-priority threads). Fair locks or limits fix it.`,
  code: r`~~~csharp
// Deadlock: opposite lock order
void Transfer(Account from, Account to, decimal amt)
{
    lock (from.Gate) lock (to.Gate) { from.Balance -= amt; to.Balance += amt; }   // A->B and B->A deadlock
}

// Fixed: canonical order by id
void TransferSafe(Account from, Account to, decimal amt)
{
    var (first, second) = from.Id < to.Id ? (from, to) : (to, from);
    lock (first.Gate) lock (second.Gate) { from.Balance -= amt; to.Balance += amt; }
}

// Callback under lock: copy, release, then call
List<Action<Quote>> handlers;
lock (_gate) { _last = quote; handlers = _handlers.ToList(); }
foreach (var h in handlers) h(quote);                  // outside the lock

// Turn hangs into errors
if (!Monitor.TryEnter(_gate, TimeSpan.FromSeconds(2)))
    throw new TimeoutException("Possible deadlock acquiring book lock");
try { /* ... */ } finally { Monitor.Exit(_gate); }
~~~`,
  pts: [r`Deadlock needs mutual exclusion, hold-and-wait, no pre-emption and circular wait.`, r`Common .NET causes: lock order, callbacks under locks, sync-over-async, pool exhaustion.`, r`Canonical lock ordering breaks circular wait.`, r`Never call unknown code while holding a lock; use timeouts to detect.`, r`Livelock: busy but no progress; starvation: one party never proceeds.`],
  ex: r`An in-memory position keeper deadlocked twice a month when two desks booked offsetting trades simultaneously; dumps showed two threads each holding one book's lock. Ordering by book id eliminated it, and TryEnter with a timeout now logs any future lock-wait over 2 seconds.`,
  fu: [r`How would you find the two threads in a production memory dump?`, r`Why does async code rarely deadlock in ASP.NET Core but often in WinForms?`, r`How do you impose lock ordering across modules owned by different teams?`],
  pit: [r`Raising events while holding a lock.`, r`Nested locks without a defined order.`, r`Fixing a deadlock by adding a sleep.`] },

{ id: 'q7', level: 'Intermediate', tags: ['thread-pool', 'internals', 'work-stealing'],
  q: r`How does the .NET thread pool work internally: global and local queues, work stealing, the hill-climbing algorithm, minimum threads and blocking detection? What does that mean for code you write?`,
  a: r`### Queues
- A **global queue** (FIFO) receives work queued from non-pool threads ({{Task.Run}} from a request thread is already a pool thread, though).
- Each worker thread has a **local queue** (LIFO for its own pushes): tasks created by a pool thread go to its local queue, improving cache locality.
- An idle worker takes from its local queue, then the global queue, then **steals** from other workers' local queues (FIFO end).
- {{TaskCreationOptions.PreferFairness}} sends a task to the global queue.

### How many threads
- The pool starts with **min threads = processor count** and creates up to that many immediately on demand.
- Above the minimum, **hill climbing** adjusts the count to maximise throughput, adding threads slowly (historically about one or two per second) when work is queued and threads are busy.
- Since .NET 6 the pool also **detects blocking** on common sync-over-async waits ({{Task.Wait}}, {{.Result}}) and injects threads faster, which mitigates but does not fix starvation.
- I/O completions run on the same worker pool on Linux (since .NET 7 the portable thread pool is used everywhere).
- Containers: {{Environment.ProcessorCount}} reflects the **CPU limit**; a pod limited to 1 CPU starts with 1 minimum worker.

### What it means for your code
- **Never block pool threads** on I/O or locks for long periods: the pool grows slowly and every queued item waits (starvation: latency climbs while CPU stays low).
- Fan-out of thousands of short CPU tasks is fine; thousands of blocking tasks is not.
- {{ThreadPool.SetMinThreads}} is a **stopgap** for unavoidable blocking (a legacy sync library), not a fix.
- Watch {{ThreadPool.PendingWorkItemCount}}, {{ThreadPool.ThreadCount}} and the {{dotnet-counters}} "ThreadPool Queue Length" and "Thread Count" counters.`,
  dia: r`flowchart LR
  E[External thread] -->|Task.Run| G[Global queue FIFO]
  subgraph Workers
    W1[Worker 1] --- L1[Local queue LIFO]
    W2[Worker 2] --- L2[Local queue LIFO]
  end
  G --> W1
  G --> W2
  W1 -->|new task| L1
  W2 -.->|steal oldest| L1
  H[Hill climbing] -->|adds or removes threads| Workers`,
  code: r`~~~csharp
// Observe the pool from inside the app
ThreadPool.GetMinThreads(out var minWorkers, out var minIo);
ThreadPool.GetMaxThreads(out var maxWorkers, out var maxIo);
Console.WriteLine($"cpu={Environment.ProcessorCount} min={minWorkers} max={maxWorkers} " +
                  $"threads={ThreadPool.ThreadCount} queued={ThreadPool.PendingWorkItemCount} done={ThreadPool.CompletedWorkItemCount}");

// Stopgap only: a legacy blocking SDK in a 2-CPU pod
ThreadPool.SetMinThreads(workerThreads: 64, completionPortThreads: 64);

// Expose pool health as metrics
var meter = new Meter("Payments.Runtime");
meter.CreateObservableGauge("threadpool.queue_length", () => ThreadPool.PendingWorkItemCount);
meter.CreateObservableGauge("threadpool.threads", () => ThreadPool.ThreadCount);
~~~
~~~bash
# Live view: queue length rising with low CPU = starvation
dotnet-counters monitor -p 1 --counters System.Runtime[threadpool-queue-length,threadpool-thread-count,cpu-usage]
~~~`,
  pts: [r`Global FIFO queue plus per-worker LIFO local queues with work stealing.`, r`Min threads = processor count; hill climbing adds threads slowly above that.`, r`.NET 6+ detects some blocking and injects faster, but blocking still hurts.`, r`Container CPU limits set ProcessorCount and thus the pool minimum.`, r`Monitor queue length and thread count; SetMinThreads is a stopgap.`],
  ex: r`A service moved from 8-CPU VMs to Kubernetes pods limited to 1 CPU; its synchronous Redis calls now starved a pool that started with one worker, and p99 rose from 30 ms to 2 s at moderate load. Moving to async Redis calls fixed it; SetMinThreads had bridged the two weeks until the rewrite.`,
  fu: [r`Why are local queues LIFO and stealing FIFO?`, r`How does a CPU limit of 500m affect ProcessorCount?`, r`What does the portable thread pool change on Windows since .NET 7?`],
  pit: [r`Raising max threads to fix starvation.`, r`Blocking pool threads on long I/O.`, r`Ignoring container CPU limits when sizing.`] },

{ id: 'q8', level: 'Intermediate', tags: ['synchronizationcontext', 'executioncontext', 'asynclocal', 'configureawait'],
  q: r`SynchronizationContext vs ExecutionContext vs TaskScheduler: what does each control when an await resumes, what flows automatically (AsyncLocal, culture, Activity), and when does ConfigureAwait(false) matter?`,
  a: r`### SynchronizationContext: *where* the continuation runs
- UI frameworks (WPF, WinForms, MAUI) install a context that posts continuations back to the **UI thread**.
- Classic ASP.NET had a request context (one thread at a time).
- **ASP.NET Core has none**: continuations run on any pool thread.
- {{await}} captures {{SynchronizationContext.Current}} (or a non-default {{TaskScheduler.Current}}) and resumes there; {{ConfigureAwait(false)}} says "do not capture, resume anywhere".

### ExecutionContext: *what ambient state* flows
Captured at the await (and by {{Task.Run}}, timers, thread-pool queueing) and restored for the continuation, regardless of thread:
- {{AsyncLocal<T>}} values (and therefore {{Activity.Current}} for tracing, logging scopes, culture via {{CultureInfo.CurrentCulture}}).
- Security/impersonation context on Windows.
Changes made **inside** an async method do not flow back **out** to the caller (copy-on-write semantics).
{{ExecutionContext.SuppressFlow()}} or {{ThreadPool.UnsafeQueueUserWorkItem}} prevent flow (use in infrastructure code to avoid leaking ambient state into long-lived background work).

### ConfigureAwait(false)
- **Libraries**: use it on every await; you do not know if the caller has a context, and capturing one costs a post and can deadlock callers that block.
- **ASP.NET Core application code**: no context exists, so it changes nothing functionally; teams usually omit it.
- **UI code**: do not use it before touching UI controls.
- .NET 8 adds {{ConfigureAwaitOptions}} ({{SuppressThrowing}}, {{ForceYielding}}) for awaits on {{Task}}.

### Common bugs
- {{AsyncLocal}} set in a background loop started from a request leaks the request's tenant or user into later work (the loop captured the request's ExecutionContext).
- Culture-sensitive formatting differs between threads only if culture was set on a thread instead of flowing.`,
  code: r`~~~csharp
// Library code: never assume a context
public async Task<Quote> GetQuoteAsync(string symbol, CancellationToken ct)
{
    var json = await _http.GetStringAsync($"/q/{symbol}", ct).ConfigureAwait(false);
    return Parse(json);
}

// AsyncLocal flows down into awaited calls and Task.Run, not back up
static readonly AsyncLocal<string?> Tenant = new();
async Task Handle()
{
    Tenant.Value = "acme";
    await Task.Run(() => Console.WriteLine(Tenant.Value));   // "acme"
    await SetInside();
    Console.WriteLine(Tenant.Value);                          // still "acme": inner change did not flow out
}
async Task SetInside() { Tenant.Value = "other"; await Task.Yield(); }

// Starting long-lived background work from a request: do not leak the request's context
using (ExecutionContext.SuppressFlow())
{
    _ = Task.Run(() => cacheRefresher.RunForeverAsync(appStopping));   // no request tenant, Activity or user captured
}

// .NET 8: await without throwing (e.g. waiting for a cancelled background task during shutdown)
await backgroundTask.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
~~~`,
  pts: [r`SynchronizationContext decides where continuations run; ASP.NET Core has none.`, r`ExecutionContext carries AsyncLocal, Activity, culture across awaits and Task.Run.`, r`AsyncLocal changes flow down, not back up to the caller.`, r`ConfigureAwait(false) in libraries; irrelevant in ASP.NET Core app code; never before UI access.`, r`SuppressFlow when starting long-lived work from a request.`],
  ex: r`A cache refresher was started lazily by the first HTTP request and captured that request's AsyncLocal tenant and Activity; for weeks every refresh log line carried tenant "acme" and the trace id of a request from Monday. SuppressFlow at startup made background telemetry correct.`,
  fu: [r`Why did sync-over-async deadlock in classic ASP.NET but not in ASP.NET Core?`, r`How does Activity.Current rely on AsyncLocal?`, r`What does ConfigureAwaitOptions.ForceYielding do?`],
  pit: [r`Assuming ConfigureAwait(false) fixes thread-pool starvation.`, r`Starting background loops from a request without suppressing flow.`, r`Using ThreadStatic for per-request data in async code.`] },

{ id: 'q9', level: 'Intermediate', tags: ['semaphoreslim', 'mutex', 'throttling', 'async-lock'],
  q: r`SemaphoreSlim vs Semaphore vs Mutex: how do you build an async lock and a concurrency throttle correctly, and what are the bugs (missing Release, reentrancy, cancellation, cross-process locking)?`,
  a: r`| Primitive | Scope | Async | Ownership |
|---|---|---|---|
| {{SemaphoreSlim}} | in-process | {{WaitAsync}} | **none**: any thread can Release |
| {{Semaphore}} | can be **named**, cross-process (OS object) | no | none |
| {{Mutex}} | can be named, cross-process | no | **thread-affine**: must be released by the owning thread; abandoned-mutex detection |
| {{lock}} / {{Lock}} | in-process | no | thread-affine, reentrant |

### SemaphoreSlim(1, 1) as an async lock
{{await sem.WaitAsync(ct)}}, then the critical section in {{try}}, and {{sem.Release()}} in {{finally}}.
- Always release in **finally**, and only if the wait succeeded (a cancelled {{WaitAsync}} throws before acquiring).
- **Not reentrant**: calling a method that waits on the same semaphore from inside the critical section deadlocks itself.
- No ownership: a bug that calls Release twice raises the count above 1 and silently lets two callers in. Pass {{maxCount}} so over-release throws {{SemaphoreFullException}}.

### SemaphoreSlim(n) as a throttle
Limits concurrent calls to a dependency (a bulkhead): {{new SemaphoreSlim(10)}} allows ten in flight. Prefer {{Parallel.ForEachAsync}} with {{MaxDegreeOfParallelism}} for fan-out loops, or {{System.Threading.RateLimiting.ConcurrencyLimiter}} for queueing limits and metrics.

### Cross-process
Named {{Mutex}} (a name with the Global prefix) for single-instance desktop apps or tools on one machine. Across **machines** none of these work: use database application locks or leases.

### Async lock pitfalls
- Holding it across long I/O serialises all callers.
- Forgetting the {{CancellationToken}} makes shutdown hang behind a stuck holder.
- Per-key locks need a {{ConcurrentDictionary<string, SemaphoreSlim>}} and a cleanup strategy, or they leak.`,
  code: r`~~~csharp
public sealed class TokenProvider(IIdentityClient idp, TimeProvider clock)
{
    private readonly SemaphoreSlim _refresh = new(initialCount: 1, maxCount: 1);   // over-release throws
    private AccessToken? _token;

    public async ValueTask<string> GetAsync(CancellationToken ct)
    {
        var t = _token;
        if (t is not null && t.ExpiresAt > clock.GetUtcNow().AddMinutes(1)) return t.Value;   // fast path, no lock

        await _refresh.WaitAsync(ct);                       // throws if cancelled: no Release needed then
        try
        {
            t = _token;                                      // double-check after acquiring
            if (t is null || t.ExpiresAt <= clock.GetUtcNow().AddMinutes(1))
                _token = t = await idp.GetTokenAsync(ct);
            return t.Value;
        }
        finally { _refresh.Release(); }
    }
}

// Throttle calls to a rate-limited partner API: at most 8 concurrent
private readonly SemaphoreSlim _partnerSlots = new(8, 8);
public async Task<Kyc> CheckAsync(string id, CancellationToken ct)
{
    if (!await _partnerSlots.WaitAsync(TimeSpan.FromSeconds(2), ct))
        throw new BulkheadRejectedException("KYC partner saturated");     // shed instead of queueing forever
    try { return await partner.CheckAsync(id, ct); }
    finally { _partnerSlots.Release(); }
}

// Single instance per machine (tooling)
using var mutex = new Mutex(initiallyOwned: false, name: @"Global\eod-batch");
if (!mutex.WaitOne(TimeSpan.Zero)) { Console.WriteLine("Already running"); return; }
~~~`,
  pts: [r`SemaphoreSlim for async locks and throttles; Mutex and named Semaphore for cross-process on one machine.`, r`Release in finally, only after a successful wait; set maxCount to catch over-release.`, r`SemaphoreSlim is not reentrant and has no owner.`, r`Use timeouts and cancellation so stuck holders do not hang everything.`, r`Across machines, use database locks or leases.`],
  ex: r`A token cache called Release in a finally block even when WaitAsync had been cancelled; the count grew to 2 and two refreshes ran concurrently, invalidating each other's tokens at the identity provider. Moving WaitAsync outside the try and setting maxCount: 1 made the bug impossible.`,
  fu: [r`How would you implement a per-key async lock without leaking semaphores?`, r`Why is a Mutex thread-affine, and what is an abandoned mutex?`, r`ConcurrencyLimiter vs SemaphoreSlim: what does the limiter add?`],
  pit: [r`WaitAsync inside the try block, releasing on failure.`, r`Re-entering the same SemaphoreSlim.`, r`Using a named Mutex to coordinate pods.`] },

{ id: 'q10', level: 'Intermediate', tags: ['signaling', 'tcs', 'events', 'coordination'],
  q: r`Signalling primitives: ManualResetEventSlim, AutoResetEvent, CountdownEvent, Barrier and TaskCompletionSource. Which do you pick, and why must TaskCompletionSource usually use RunContinuationsAsynchronously?`,
  a: r`| Primitive | Semantics | Async-friendly |
|---|---|---|
| {{ManualResetEventSlim}} | gate: Set opens for everyone until Reset; spins briefly before blocking | no (blocking Wait) |
| {{AutoResetEvent}} | turnstile: Set releases **one** waiter, then closes; kernel object | no |
| {{CountdownEvent}} | opens when a count reaches zero (wait for N operations) | no |
| {{Barrier}} | N participants wait for each other at phase boundaries | no |
| {{TaskCompletionSource<T>}} | a Task you complete manually: one-shot signal or result | **yes**: await its Task |

In async code, blocking waits ({{Wait()}}) occupy pool threads, so prefer **TaskCompletionSource** for one-shot signals, **SemaphoreSlim** for counting signals, and **Channels** for streams of signals.

### TaskCompletionSource and inline continuations
By default {{SetResult}} runs the awaiting continuations **synchronously on the thread that calls SetResult**. If that thread holds a lock, is an I/O callback thread, or is in the middle of a loop, the continuation runs inside it: lock reentrancy surprises, stack dives, and stalls of the completing component. Create it with {{TaskCreationOptions.RunContinuationsAsynchronously}} so continuations are queued to the pool. Make it the default in your codebase.

### Other TCS rules
- Use {{TrySetResult}} / {{TrySetException}} / {{TrySetCanceled}} when several paths may complete it.
- Register cancellation: {{ct.Register(() => tcs.TrySetCanceled(ct))}} and dispose the registration.
- An abandoned TCS (never completed) leaves its awaiters hanging forever: always complete it on every path, including disposal.
- .NET 9 adds non-generic {{TaskCompletionSource}} for no-result signals.`,
  code: r`~~~csharp
// One-shot "warm-up complete" signal for readiness probes
public sealed class Readiness
{
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task WhenReady => _ready.Task;
    public void MarkReady() => _ready.TrySetResult();
}

// Bridging a callback API to async, with cancellation and no inline continuations
public static Task<Fill> WaitForFillAsync(IOrderGateway gw, string orderId, CancellationToken ct)
{
    var tcs = new TaskCompletionSource<Fill>(TaskCreationOptions.RunContinuationsAsynchronously);
    void OnFill(Fill f) { if (f.OrderId == orderId) tcs.TrySetResult(f); }
    gw.Filled += OnFill;
    var reg = ct.Register(() => tcs.TrySetCanceled(ct));
    _ = tcs.Task.ContinueWith(_ => { gw.Filled -= OnFill; reg.Dispose(); }, TaskScheduler.Default);   // always unhook
    return tcs.Task;
}

// Wait for N parallel loaders (blocking world): CountdownEvent
using var done = new CountdownEvent(shards.Length);
foreach (var s in shards) ThreadPool.QueueUserWorkItem(_ => { try { Load(s); } finally { done.Signal(); } });
done.Wait(TimeSpan.FromMinutes(5));

// Async equivalent: just await the tasks
await Task.WhenAll(shards.Select(s => LoadAsync(s, ct)));
~~~`,
  pts: [r`Gates, turnstiles, countdowns and barriers block threads; prefer them only in synchronous code.`, r`TaskCompletionSource is the async one-shot signal.`, r`Use RunContinuationsAsynchronously to avoid continuations running inside SetResult.`, r`TrySet* for racing completers; register and dispose cancellation; never abandon a TCS.`, r`For async code: TCS, SemaphoreSlim, Channels, Task.WhenAll.`],
  ex: r`A market-data client completed a TaskCompletionSource from its socket receive loop without RunContinuationsAsynchronously; a slow consumer's continuation ran on the receive thread and stalled the feed for every other subscriber. Adding the option moved continuations to the pool and removed 800 ms feed gaps.`,
  fu: [r`Why does ManualResetEventSlim spin before blocking?`, r`What goes wrong if you call SetResult twice?`, r`How would you implement an async auto-reset event?`],
  pit: [r`TCS without RunContinuationsAsynchronously in library code.`, r`Blocking Wait() on events inside async code.`, r`Never completing a TCS on error paths.`] },

{ id: 'q11', level: 'Intermediate', tags: ['readerwriterlockslim', 'copy-on-write', 'immutability', 'read-mostly'],
  q: r`A read-mostly reference-data cache (FX rates, BIN tables) is read 50,000 times a second and replaced every few minutes. Compare lock, ReaderWriterLockSlim and an immutable snapshot swapped atomically.`,
  a: r`### lock
Simple and correct, but every read serialises through one lock: at high read rates contention on the lock (and its cache line) becomes the bottleneck.

### ReaderWriterLockSlim
Many concurrent readers or one writer. Costs: more expensive than a plain lock per acquisition (often slower than lock for short read sections), thread-affine (**no await inside**), optional recursion, writer starvation trade-offs, and it must be disposed. Useful when read sections are relatively long and writes are frequent enough that copying is costly.

### Immutable snapshot + atomic swap (copy-on-write)
Build a **new** immutable structure off to the side, then publish it with a single reference assignment ({{Volatile.Write}} or {{Interlocked.Exchange}}). Readers take the current reference ({{Volatile.Read}}) and use it **without any lock**; they always see a complete, consistent snapshot. Old snapshots are garbage collected when no reader holds them.
- Reads: one memory read, no contention, scales with cores.
- Writes: rebuild the whole structure (fine when replaced every few minutes or when changes are batched).
- {{FrozenDictionary}} (.NET 8) is ideal for the snapshot: slower to build, faster to read than Dictionary.
- Multi-writer updates of a snapshot need a **CAS loop** ({{ImmutableInterlocked.Update}}).

### Decision
| Workload | Choice |
|---|---|
| read-mostly, rare bulk replacement | immutable snapshot swap |
| frequent small writes, moderate reads | ConcurrentDictionary |
| long read sections, frequent writes, sync code | ReaderWriterLockSlim |
| low contention, compound updates | lock |`,
  code: r`~~~csharp
public sealed class FxRateCache(IRateSource source, ILogger<FxRateCache> log)
{
    private FrozenDictionary<string, decimal> _rates = FrozenDictionary<string, decimal>.Empty;

    // Readers: lock-free, always a complete snapshot
    public bool TryGet(string pair, out decimal rate) => Volatile.Read(ref _rates).TryGetValue(pair, out rate);

    // Writer: build off to the side, publish atomically
    public async Task RefreshAsync(CancellationToken ct)
    {
        var fresh = (await source.LoadAllAsync(ct)).ToFrozenDictionary(r => r.Pair, r => r.Rate, StringComparer.Ordinal);
        if (fresh.Count == 0) { log.LogWarning("Empty rate set ignored"); return; }   // never publish an empty snapshot
        Volatile.Write(ref _rates, fresh);
    }
}

// Multi-writer immutable update with a CAS loop
private ImmutableDictionary<string, Limit> _limits = ImmutableDictionary<string, Limit>.Empty;
public void SetLimit(string desk, Limit l) => ImmutableInterlocked.AddOrUpdate(ref _limits, desk, l, (_, _) => l);

// ReaderWriterLockSlim, for comparison (sync code only, dispose it)
private readonly ReaderWriterLockSlim _rw = new();
public decimal Read(string k) { _rw.EnterReadLock(); try { return _dict[k]; } finally { _rw.ExitReadLock(); } }
~~~`,
  pts: [r`lock serialises readers; fine at low contention.`, r`ReaderWriterLockSlim: concurrent readers, but costly, thread-affine, no await.`, r`Copy-on-write: build new immutable data, publish with one atomic reference write.`, r`Readers use Volatile.Read and never lock; FrozenDictionary for fast reads.`, r`ImmutableInterlocked for concurrent writers via CAS.`],
  ex: r`A card-authorisation service guarded its BIN table with ReaderWriterLockSlim; at 60,000 reads/s, profiling showed 22% of CPU in lock acquisition. A FrozenDictionary snapshot swapped every five minutes removed the lock entirely and cut authorisation p99 by 4 ms.`,
  fu: [r`Why must the snapshot be immutable after publication?`, r`What happens to readers holding the old snapshot during a swap?`, r`How do you avoid publishing a partially loaded or empty rate set?`],
  pit: [r`Mutating a published snapshot in place.`, r`ReaderWriterLockSlim around tiny read sections.`, r`Await inside a ReaderWriterLockSlim section.`] },

{ id: 'q12', level: 'Intermediate', tags: ['concurrent-collections', 'concurrentdictionary', 'frozen', 'immutable'],
  q: r`Concurrent collections in depth: how does ConcurrentDictionary work, why can GetOrAdd run its factory twice, what do Count and enumeration cost, and when do you use ConcurrentQueue, ConcurrentBag, BlockingCollection, Immutable or Frozen collections?`,
  a: r`### ConcurrentDictionary
- **Lock striping**: buckets are protected by a set of locks (by default proportional to processor count); writes lock one stripe; **reads are lock-free**.
- {{GetOrAdd(key, factory)}} and {{AddOrUpdate}} run the factory **outside** the lock: under a race, two threads can both run the factory; only one value is stored. If the factory is expensive or has side effects (opens a connection, calls an API), wrap the value in {{Lazy<T>}} so only one is ever executed.
- {{Count}}, {{IsEmpty}} (cheaper), {{Keys}}, {{Values}} and {{ToArray}} take **all** locks: expensive and contention-heavy in hot paths.
- Enumeration is **lock-free and not a snapshot**: you may see some concurrent changes and not others, but it never throws.
- Compound logic ({{if value > x then update}}) is not atomic: use {{TryUpdate(key, new, comparison)}} in a loop or {{AddOrUpdate}}.

### Other collections
| Collection | Use |
|---|---|
| {{ConcurrentQueue<T>}} | lock-free FIFO, multiple producers and consumers |
| {{ConcurrentStack<T>}} | lock-free LIFO |
| {{ConcurrentBag<T>}} | thread-local lists with stealing; good when the **same threads** produce and consume (object pools), poor as a general queue |
| {{BlockingCollection<T>}} | bounded blocking producer/consumer (sync). In async code prefer {{Channel<T>}} |
| {{ImmutableDictionary/List}} | persistent structures, cheap "modified copies"; slower reads (tree) |
| {{FrozenDictionary/Set}} (.NET 8) | built once, fastest reads; for static or snapshot data |

### Choosing
Lots of concurrent writes and reads → ConcurrentDictionary. Read-mostly, replaced in bulk → Frozen snapshot. Need value semantics and history → Immutable. Producer/consumer → Channel.`,
  code: r`~~~csharp
// Expensive factory: ensure it runs once per key
private readonly ConcurrentDictionary<string, Lazy<Task<MerchantConfig>>> _configs = new();
public Task<MerchantConfig> GetConfigAsync(string merchantId) =>
    _configs.GetOrAdd(merchantId, id => new Lazy<Task<MerchantConfig>>(() => LoadConfigAsync(id))).Value;
// (on failure, remove the faulted entry so the next caller retries)

// Atomic conditional update with TryUpdate in a CAS loop
public bool TryReserve(string card, decimal amount, decimal limit)
{
    while (true)
    {
        var current = _spent.GetOrAdd(card, 0m);
        if (current + amount > limit) return false;
        if (_spent.TryUpdate(card, current + amount, current)) return true;   // retry if someone else changed it
    }
}

// Hot path: IsEmpty is cheap; Count takes every lock
if (!_pending.IsEmpty) Drain();

// Increment counters per key
_hits.AddOrUpdate(route, 1, (_, n) => n + 1);

// Static reference data: frozen for fastest reads
static readonly FrozenSet<string> SanctionedCountries = new[] { "KP", "IR", "SY" }.ToFrozenSet(StringComparer.Ordinal);
~~~`,
  pts: [r`Striped locks for writes, lock-free reads.`, r`GetOrAdd factories can run more than once: wrap in Lazy for side effects.`, r`Count, Keys, Values take all locks; enumeration is not a snapshot.`, r`Compound updates via TryUpdate CAS loops or AddOrUpdate.`, r`Channel for producer/consumer; Frozen for read-mostly; ConcurrentBag only for same-thread pooling.`],
  ex: r`A merchant-config cache used GetOrAdd with a factory that called a config service; at startup 300 concurrent requests for the same merchant triggered 300 config calls and the config service was rate-limited, failing startup. Lazy<Task<T>> values made it one call per merchant.`,
  fu: [r`Why does ConcurrentDictionary not run the factory under the lock?`, r`What is the downside of caching a faulted Lazy<Task<T>>?`, r`Why is ConcurrentBag a poor general-purpose queue?`],
  pit: [r`Side-effecting factories in GetOrAdd.`, r`Count in hot paths.`, r`check-then-act on a ConcurrentDictionary assumed atomic.`] },

{ id: 'q13', level: 'Intermediate', tags: ['interlocked', 'cas', 'lock-free'],
  q: r`Interlocked in depth: Increment, Add, Exchange, CompareExchange and the CAS loop. Implement a lock-free max tracker and a lock-free stack, and explain the ABA problem and when lock-free is the wrong choice.`,
  a: r`### Operations
| Method | Atomic effect |
|---|---|
| {{Increment}} / {{Decrement}} / {{Add}} | read-modify-write on int/long (and uint/ulong) |
| {{Exchange(ref x, v)}} | set and return the old value |
| {{CompareExchange(ref x, new, expected)}} | set to new **only if** x still equals expected; returns the value it saw |
| {{Read(ref long)}} | atomic 64-bit read on 32-bit platforms |
| {{And}} / {{Or}} (.NET 5+) | bit operations |
Each is a **full memory fence**.

### The CAS loop
For any update that is not a built-in operation: read the current value, compute the new one, {{CompareExchange}}; if someone changed it in between, **retry**. Correct as long as the computation is pure and cheap; under heavy contention many retries waste CPU.

### ABA
A CAS checks "is it still A?". If another thread changed A to B and back to A (or freed and reused a node at the same address), the CAS succeeds on stale assumptions. In .NET the GC prevents address reuse while you hold a reference, which removes the classic memory-reuse ABA for reference types, but **value-based** ABA (a counter or state that cycles) remains. Mitigate with version stamps (a tuple of value plus version) or immutable nodes.

### When lock-free is wrong
- Multi-variable invariants: you cannot CAS two fields atomically (combine them in one immutable object and CAS the reference).
- High contention with expensive retries: a lock queues waiters fairly; CAS loops spin.
- Code that others must maintain: lock-free algorithms are hard to review and test.
Use Interlocked for counters, flags, one-time initialisation and reference swaps; use locks for everything else unless profiling proves otherwise.`,
  code: r`~~~csharp
// Lock-free "max seen" tracker (CAS loop)
private long _maxLatencyTicks;
public void Record(long ticks)
{
    long current = Volatile.Read(ref _maxLatencyTicks);
    while (ticks > current)
    {
        long seen = Interlocked.CompareExchange(ref _maxLatencyTicks, ticks, current);
        if (seen == current) break;          // we won
        current = seen;                      // someone else changed it; re-check
    }
}

// Run-once guard without a lock
private int _started;
public void StartOnce() { if (Interlocked.Exchange(ref _started, 1) == 0) StartListener(); }

// Lock-free (Treiber) stack: immutable nodes, CAS on the head reference
public sealed class LockFreeStack<T>
{
    private sealed record Node(T Value, Node? Next);
    private Node? _head;
    public void Push(T v)
    {
        Node? head;
        do { head = Volatile.Read(ref _head); } while (Interlocked.CompareExchange(ref _head, new Node(v, head), head) != head);
    }
    public bool TryPop(out T value)
    {
        Node? head;
        do
        {
            head = Volatile.Read(ref _head);
            if (head is null) { value = default!; return false; }
        } while (Interlocked.CompareExchange(ref _head, head.Next, head) != head);
        value = head.Value; return true;
    }
}

// Two fields that must change together: CAS one immutable reference
private sealed record Quote(decimal Bid, decimal Ask, long Seq);
private Quote _quote = new(0, 0, 0);
public void Publish(decimal bid, decimal ask) =>
    Interlocked.Exchange(ref _quote, new Quote(bid, ask, _quote.Seq + 1));   // readers never see bid/ask mismatched
~~~`,
  pts: [r`Interlocked operations are atomic with full fences.`, r`CAS loop: read, compute, CompareExchange, retry on change.`, r`ABA: the GC removes address reuse, value-cycling ABA remains; use versions.`, r`Multi-field invariants: CAS one immutable reference.`, r`Lock-free for counters, flags and swaps; locks for the rest unless measured.`],
  ex: r`A quote publisher wrote Bid and Ask as two separate volatile fields; consumers occasionally saw a new bid with an old ask (a crossed market) and an algo rejected valid orders. Publishing an immutable Quote record via one reference swap fixed it.`,
  fu: [r`Why does a CAS loop need the computation to be side-effect free?`, r`How would you build a lock-free bounded queue, and would you?`, r`What does Interlocked.Read solve on 32-bit platforms?`],
  pit: [r`Side effects inside CAS retry loops.`, r`Two separate atomic fields expected to be consistent.`, r`Lock-free code without stress tests.`] },

{ id: 'q14', level: 'Intermediate', tags: ['channels', 'producer-consumer', 'backpressure'],
  q: r`Design an in-process producer/consumer pipeline with System.Threading.Channels: bounded vs unbounded, full modes, reader/writer options, completion, multiple consumers, error handling and graceful shutdown.`,
  a: r`### Creating the channel
- {{Channel.CreateBounded<T>(capacity)}} gives **backpressure**: when full, writers wait ({{FullMode.Wait}}) or the channel drops ({{DropOldest}}, {{DropNewest}}, {{DropWrite}}; with an {{itemDropped}} callback in .NET 6+).
- {{CreateUnbounded}} never blocks writers: memory is the only limit. Only for producers that are inherently bounded.
- {{SingleReader}} / {{SingleWriter}} enable faster implementations when true; {{AllowSynchronousContinuations}} = false (default) avoids running consumer code on the producer's thread.

### Writing and reading
- {{await writer.WriteAsync(item, ct)}} waits when full; {{TryWrite}} returns false instead.
- {{await foreach (var x in reader.ReadAllAsync(ct))}}, or the {{WaitToReadAsync}} / {{TryRead}} loop for batching.
- Multiple consumers: start N tasks reading the same reader; each item goes to exactly one consumer; **order across consumers is not preserved**.

### Completion
- The producer calls {{writer.Complete()}} (or {{Complete(exception)}} to propagate a failure).
- Consumers' {{ReadAllAsync}} ends after draining remaining items; {{reader.Completion}} completes when everything is read.

### Errors and shutdown
- Catch per item in consumers: one poison message must not kill the consumer loop. Record and dead-letter.
- On shutdown: stop accepting (complete the writer), let consumers **drain** within a deadline, then cancel. In-memory channels lose items on a crash: if items must survive, the channel is a buffer in front of a durable source (Kafka, a database outbox), with acknowledgement after processing.

### Channels vs alternatives
BlockingCollection: synchronous, blocks threads. TPL Dataflow: richer graphs, more ceremony. Rx: push-based event transformations, no backpressure by default.`,
  code: r`~~~csharp
public sealed class EnrichmentPipeline : BackgroundService
{
    private readonly Channel<PaymentEvent> _channel = Channel.CreateBounded<PaymentEvent>(
        new BoundedChannelOptions(capacity: 10_000)
        { FullMode = BoundedChannelFullMode.Wait, SingleWriter = false, SingleReader = false });

    public ValueTask EnqueueAsync(PaymentEvent e, CancellationToken ct) => _channel.Writer.WriteAsync(e, ct);   // backpressure

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var consumers = Enumerable.Range(0, 8).Select(_ => ConsumeAsync(stop)).ToArray();
        await Task.WhenAll(consumers);
    }

    private async Task ConsumeAsync(CancellationToken stop)
    {
        await foreach (var e in _channel.Reader.ReadAllAsync(stop))
        {
            try { await ProcessAsync(e, stop); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.LogError(ex, "Event {Id} failed", e.Id);
                await _deadLetters.AddAsync(e, ex, stop);                  // one bad item does not stop the loop
            }
        }
    }

    public override async Task StopAsync(CancellationToken hostDeadline)
    {
        _channel.Writer.TryComplete();                                     // stop accepting
        using var drain = CancellationTokenSource.CreateLinkedTokenSource(hostDeadline);
        drain.CancelAfter(TimeSpan.FromSeconds(20));                       // bounded drain
        try { await _channel.Reader.Completion.WaitAsync(drain.Token); } catch (OperationCanceledException) { }
        await base.StopAsync(hostDeadline);
    }
}

// Batching reader: up to 500 items or what is available
while (await reader.WaitToReadAsync(ct))
{
    var batch = new List<Txn>(500);
    while (batch.Count < 500 && reader.TryRead(out var t)) batch.Add(t);
    await sink.WriteBatchAsync(batch, ct);
}
~~~`,
  pts: [r`Bounded channels provide backpressure; unbounded only for naturally bounded producers.`, r`FullMode chooses wait vs drop; SingleReader/SingleWriter enable fast paths.`, r`Complete the writer; consumers drain and end; Completion signals the end.`, r`Per-item error handling and dead-lettering inside consumers.`, r`In-memory channels lose items on crash: buffer in front of a durable source.`],
  ex: r`A webhook ingestion service used an unbounded channel; when the downstream fraud service slowed, 4 million events piled up in memory and the pod was OOM-killed, losing them all. A bounded channel returning 503 when full, in front of Kafka for durability, fixed both problems.`,
  fu: [r`How do you preserve per-key order with multiple consumers?`, r`When is DropOldest the right full mode?`, r`How would you measure channel depth as a metric?`],
  pit: [r`Unbounded channels in front of slow consumers.`, r`One exception ending the consumer loop.`, r`Assuming items survive a pod restart.`] },

{ id: 'q15', level: 'Intermediate', tags: ['cancellation', 'timeouts', 'cancellationtoken'],
  q: r`Design cancellation and timeouts properly: CancellationTokenSource, linked tokens, CancelAfter, Task.WaitAsync, registrations, disposing sources, and how to tell a timeout from a caller cancel.`,
  a: r`### The model
Cancellation is **cooperative**: a {{CancellationTokenSource}} signals; code that receives the {{CancellationToken}} checks it ({{ThrowIfCancellationRequested}}) or passes it to APIs that observe it. Nothing is aborted forcibly.

### Patterns
- **Accept a token in every async API** and pass it all the way down (HTTP, database, channel reads, delays).
- **Timeouts**: a CTS with {{CancelAfter(timeout)}}, **linked** to the caller's token ({{CreateLinkedTokenSource}}) so either can cancel.
- {{Task.WaitAsync(timeout, ct)}} (.NET 6+) stops *waiting* for a task that does not accept a token; the underlying work keeps running.
- Dispose linked and timer-based sources (they hold registrations and timers).
- {{ct.Register(callback)}} for APIs that need a callback (closing a socket); dispose the registration when done.

### Distinguishing outcomes
An {{OperationCanceledException}} can mean the **caller** cancelled (client disconnected: do not log as an error) or **your timeout** fired (a dependency was slow: log and count it). Check which token is cancelled:
{{catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !callerCt.IsCancellationRequested)}} → timeout.

### Rules
- Do not catch and swallow cancellation in the middle of a call chain; let it propagate.
- After cancellation, leave state consistent: cancellation can happen between two writes; transactions or compensation handle that.
- Do not pass a token to the final "commit" step of a must-complete operation (posting a ledger entry after the payment was captured): use {{CancellationToken.None}} there deliberately.
- ASP.NET Core: {{HttpContext.RequestAborted}} is injected as the endpoint's {{CancellationToken}}.`,
  code: r`~~~csharp
public async Task<Quote> GetQuoteAsync(string symbol, CancellationToken callerCt)
{
    using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(callerCt);
    timeoutCts.CancelAfter(TimeSpan.FromMilliseconds(300));                       // per-dependency budget
    try
    {
        return await _pricing.GetAsync(symbol, timeoutCts.Token);
    }
    catch (OperationCanceledException) when (!callerCt.IsCancellationRequested)
    {
        _metrics.PricingTimeouts.Add(1);
        throw new DependencyTimeoutException("pricing", TimeSpan.FromMilliseconds(300));   // a timeout, not a client cancel
    }
}

// Stop waiting for an API that ignores tokens (the work itself continues)
var report = await legacy.GenerateAsync(request).WaitAsync(TimeSpan.FromSeconds(30), ct);

// Callback-based cancellation for a blocking/legacy resource
using var reg = ct.Register(static s => ((Socket)s!).Close(), socket);

// Must-complete step: deliberately not cancellable
await _ledger.PostCaptureAsync(paymentId, amount, CancellationToken.None);

// Cancellation-aware CPU loop
for (var i = 0; i < paths; i++)
{
    if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();   // check periodically, not every iteration
    Simulate(i);
}
~~~`,
  pts: [r`Cancellation is cooperative: pass tokens everywhere.`, r`Linked CTS + CancelAfter for per-dependency timeouts; dispose the sources.`, r`Distinguish timeout from caller cancel by checking which token fired.`, r`WaitAsync stops waiting, not the work.`, r`Must-complete steps use CancellationToken.None deliberately.`],
  ex: r`A capture endpoint passed RequestAborted into the final ledger write; when mobile clients dropped connections after the card was charged, the ledger entry was cancelled and money moved without a record. The ledger call now uses CancellationToken.None and the capture runs in an idempotent, resumable workflow.`,
  fu: [r`What happens to a database command when its token is cancelled?`, r`Why should you not log OperationCanceledException from client disconnects as errors?`, r`How do deadlines propagate across services?`],
  pit: [r`Swallowing OperationCanceledException.`, r`Not disposing linked or timer-based CTS.`, r`Cancelling irreversible steps halfway.`] },

{ id: 'q16', level: 'Intermediate', tags: ['timers', 'periodictimer', 'timeprovider'],
  q: r`System.Threading.Timer vs System.Timers.Timer vs PeriodicTimer vs Task.Delay loops: how do they behave under slow callbacks (overlap, reentrancy), what keeps them alive, and how do you test time-based code?`,
  a: r`| Timer | Callback | Overlap | Notes |
|---|---|---|---|
| {{System.Threading.Timer}} | on a pool thread | **yes**: if a callback takes longer than the period, the next one starts concurrently | lightweight; must be **rooted** (stored in a field) or it can be garbage collected and stop firing |
| {{System.Timers.Timer}} | {{Elapsed}} event on a pool thread (or a SynchronizingObject) | yes | **swallows exceptions** in Elapsed (silent failures); AutoReset property |
| {{PeriodicTimer}} (.NET 6+) | you {{await WaitForNextTickAsync}} in a loop | **no**: the loop is sequential; missed ticks coalesce | async-friendly, cancellable; the recommended choice for background loops |
| {{Task.Delay}} loop | sequential | no | period drifts by the work duration unless you compute the next deadline |

### Reentrancy
With Threading.Timer, a slow callback (a database call during an incident) overlaps with the next, multiplying load exactly when the dependency is struggling. Guard with an Interlocked flag, use one-shot timers re-armed at the end ({{Change(dueTime, Timeout.Infinite)}}), or use PeriodicTimer.

### Exceptions
An unhandled exception in a Threading.Timer callback **crashes the process**; in Timers.Timer it is **swallowed**. Neither is what you want: catch, log and count inside the callback.

### Testing
Inject {{TimeProvider}} (.NET 8): {{TimeProvider.System}} in production, {{FakeTimeProvider}} in tests to advance time deterministically ({{Advance(TimeSpan)}}) without sleeping. PeriodicTimer, Task.Delay, CancelAfter and timers accept a TimeProvider.

### Distributed schedules
Timers fire in **every replica**. For "once per cluster" jobs use a scheduler with leader election or a database lease (Quartz clustering, Hangfire, a Kubernetes CronJob).`,
  code: r`~~~csharp
// Recommended: PeriodicTimer loop, no overlap, testable time
public sealed class RateRefresher(FxRateCache cache, TimeProvider time, ILogger<RateRefresher> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1), time);
        do
        {
            try { await cache.RefreshAsync(stop); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Rate refresh failed"); }
        }
        while (await timer.WaitForNextTickAsync(stop));
    }
}

// Threading.Timer with an overlap guard (rooted in a field)
private Timer? _timer; private int _running;
public void Start() => _timer = new Timer(_ =>
{
    if (Interlocked.Exchange(ref _running, 1) == 1) return;   // previous run still going: skip
    try { Flush(); } catch (Exception ex) { _log.LogError(ex, "Flush failed"); }
    finally { Volatile.Write(ref _running, 0); }
}, null, TimeSpan.Zero, TimeSpan.FromSeconds(5));

// Deterministic test with FakeTimeProvider
[Fact]
public async Task Refreshes_every_minute()
{
    var time = new FakeTimeProvider();
    var cache = new CountingCache();
    using var sut = new RateRefresher(cache, time, NullLogger<RateRefresher>.Instance);
    await sut.StartAsync(default);
    time.Advance(TimeSpan.FromMinutes(3));
    await Task.Yield();
    Assert.Equal(4, cache.Refreshes);       // initial + 3 ticks
}
~~~`,
  pts: [r`Threading.Timer callbacks overlap; root the timer in a field.`, r`Timers.Timer swallows exceptions; Threading.Timer exceptions crash the process.`, r`PeriodicTimer gives sequential, cancellable async loops.`, r`TimeProvider and FakeTimeProvider make time testable.`, r`Timers run in every replica: use leases or schedulers for cluster-wide jobs.`],
  ex: r`A reconciliation job on a 30-second Threading.Timer overlapped itself during a database slowdown: 12 concurrent runs locked the same tables and turned a slowdown into an outage. A PeriodicTimer loop with a database lease made it single-run per cluster.`,
  fu: [r`Why can an unrooted Threading.Timer stop firing?`, r`How do you schedule "at 18:00 London time" correctly across DST?`, r`How would you test a retry backoff without waiting?`],
  pit: [r`Overlapping timer callbacks under load.`, r`Silent exceptions in Timers.Timer.`, r`Thread.Sleep in tests for time-based logic.`] },

{ id: 'q17', level: 'Intermediate', tags: ['parallel', 'plinq', 'data-parallelism'],
  q: r`Parallel.For/ForEach, PLINQ and Parallel.ForEachAsync: when does each fit, how do partitioning, thread-local state and MaxDegreeOfParallelism work, and what are the classic mistakes?`,
  a: r`### Which one
| API | Work type | Notes |
|---|---|---|
| {{Parallel.For}} / {{ForEach}} | **CPU-bound**, synchronous | blocks the calling thread until done; uses the pool; partitions the input |
| PLINQ ({{AsParallel()}}) | CPU-bound **queries** | declarative; {{AsOrdered}} preserves order at a cost; {{WithDegreeOfParallelism}} |
| {{Parallel.ForEachAsync}} (.NET 6+) | **I/O-bound** or mixed async work | async body; default parallelism = processor count, set it explicitly for I/O |
| {{Task.WhenAll}} over all items | small, bounded sets | unbounded concurrency for large sets |

### Partitioning
Parallel.ForEach chunks the input; for small, uneven work items use {{Partitioner.Create(source, EnumerablePartitionerOptions.NoBuffering)}} or range partitioning ({{Partitioner.Create(0, n, rangeSize)}}) to reduce per-item overhead.

### Thread-local state
Aggregations should not lock a shared total per item. Use the overload with {{localInit}}, body and {{localFinally}}: each worker accumulates locally, merging once at the end.

### Degree of parallelism
- CPU-bound: default (processor count) is right; more threads only add switching.
- I/O-bound: set by the **dependency's capacity** (a partner API allows 20 concurrent calls), not by cores.
- In a web server, CPU parallelism per request competes with other requests; a request that uses all cores hurts everyone else. Cap it or move it to a background job.

### Classic mistakes
- Shared mutable state in the body (List.Add from many threads).
- {{Parallel.ForEach}} with an **async lambda**: it becomes {{async void}}, returns immediately, and exceptions crash the process. Use ForEachAsync.
- Tiny work items where overhead dominates; measure.
- Exceptions arrive as {{AggregateException}}; cancellation via {{ParallelOptions.CancellationToken}}.`,
  code: r`~~~csharp
// CPU-bound aggregation with thread-local subtotals (no per-item locking)
decimal total = 0m; object gate = new();
Parallel.ForEach(Partitioner.Create(0, trades.Length, 10_000),
    () => 0m,                                                     // localInit
    (range, _, subtotal) =>
    {
        for (var i = range.Item1; i < range.Item2; i++) subtotal += Revalue(trades[i]);
        return subtotal;
    },
    subtotal => { lock (gate) total += subtotal; });             // localFinally: once per worker

// PLINQ for a CPU-heavy query
var risky = portfolios.AsParallel().WithDegreeOfParallelism(Environment.ProcessorCount)
    .Where(p => VaR(p) > p.Limit).Select(p => p.Id).ToList();

// I/O-bound fan-out bounded by the partner's limit
await Parallel.ForEachAsync(accountIds,
    new ParallelOptions { MaxDegreeOfParallelism = 20, CancellationToken = ct },
    async (id, token) => await statements.GenerateAsync(id, token));

// Bug: async lambda in Parallel.ForEach = async void; returns before work finishes
// Parallel.ForEach(ids, async id => await SendAsync(id));
~~~`,
  pts: [r`Parallel and PLINQ for CPU-bound work; ForEachAsync for async I/O.`, r`Partitioners and range chunks reduce overhead for small items.`, r`localInit/localFinally avoid locking per item.`, r`Set parallelism by dependency capacity for I/O, by cores for CPU.`, r`Never pass async lambdas to Parallel.ForEach.`],
  ex: r`An end-of-day revaluation of 2 million trades ran single-threaded in 50 minutes; Parallel.ForEach with range partitioning and thread-local subtotals ran in 7 minutes on 8 cores. The same team had earlier broken statement generation with Parallel.ForEach(async ...), which silently returned before any statement was sent.`,
  fu: [r`Why can PLINQ be slower than sequential LINQ?`, r`How do you preserve output order in PLINQ, and what does it cost?`, r`How do exceptions surface from Parallel.ForEach?`],
  pit: [r`Async lambdas in Parallel.ForEach.`, r`Locking a shared accumulator per item.`, r`Unbounded Task.WhenAll over large sets.`] },

{ id: 'q18', level: 'Intermediate', tags: ['threadstatic', 'threadlocal', 'asynclocal', 'ambient-state'],
  q: r`[ThreadStatic] vs ThreadLocal<T> vs AsyncLocal<T>: what does each store, which survive an await, and what bugs come from pool threads reusing thread-local state?`,
  a: r`| Mechanism | Scope | Survives await | Notes |
|---|---|---|---|
| {{[ThreadStatic]}} static field | per OS thread | **no**: after an await you may be on another thread | field initialiser runs only on the first thread; others see default |
| {{ThreadLocal<T>}} | per thread, per instance | no | lazy factory per thread; {{Values}} enumerates all (with trackAllValues); must be disposed |
| {{AsyncLocal<T>}} | per **logical flow** (ExecutionContext) | **yes** | flows into child tasks; changes do not flow back to callers |

### Bugs from pool-thread reuse
- **Leaking state between requests**: a ThreadStatic "current user" or "current tenant" set by one request remains on the pool thread and is seen by the next request that runs there if not cleared. A security bug.
- **Lost state across await**: per-request data in ThreadStatic disappears after the first await that resumes on another thread.
- **Unbounded memory**: ThreadLocal caches holding large buffers on many pool threads.

### Appropriate uses
- {{[ThreadStatic]}} / {{ThreadLocal}}: per-thread **caches of non-thread-safe helpers** in synchronous hot paths (a reusable buffer, a hashing instance), never for per-request identity.
- {{AsyncLocal}}: ambient **request** context (correlation id, Activity, tenant) when passing parameters is impractical. Prefer explicit parameters or DI scoped services; ambient state hides dependencies.

### AsyncLocal costs
Each set allocates a new immutable context map; frequent sets in hot loops allocate. Values captured by background work started from a request leak into it (suppress flow when starting long-lived work).`,
  code: r`~~~csharp
// Bug: per-request identity in a ThreadStatic field
public static class CurrentUser
{
    [ThreadStatic] public static string? Id;     // leaks to the next request on this pool thread; lost after await
}

// Correct ambient request context (flows across awaits)
public static class Correlation
{
    private static readonly AsyncLocal<string?> _id = new();
    public static string? Id { get => _id.Value; set => _id.Value = value; }
}
app.Use(async (ctx, next) =>
{
    Correlation.Id = ctx.Request.Headers["X-Correlation-Id"].FirstOrDefault() ?? Guid.NewGuid().ToString("N");
    await next();
});

// Legitimate thread-local: cache a non-thread-safe helper in a synchronous hot path
private static readonly ThreadLocal<IncrementalHash> Sha = new(() => IncrementalHash.CreateHash(HashAlgorithmName.SHA256));
public static byte[] Fingerprint(ReadOnlySpan<byte> data)
{
    var h = Sha.Value!;
    h.AppendData(data);
    return h.GetHashAndReset();                  // no await between use and reset
}
~~~`,
  pts: [r`ThreadStatic and ThreadLocal are per OS thread and do not survive awaits.`, r`AsyncLocal follows the logical async flow.`, r`Pool-thread reuse leaks thread-static state between requests.`, r`Thread-locals for synchronous helper caches; AsyncLocal or DI for request context.`, r`AsyncLocal sets allocate and leak into background work started from requests.`],
  ex: r`A legacy authorisation helper stored the current merchant id in a ThreadStatic field; after the API was converted to async, about one request in 10,000 ran with the previous request's merchant id. The audit found 14 cross-merchant reads; the fix moved identity to a scoped service populated from the token.`,
  fu: [r`Why does a ThreadStatic field initialiser only run once?`, r`How does Activity.Current work across awaits?`, r`When would you dispose a ThreadLocal, and what happens if you do not?`],
  pit: [r`ThreadStatic for per-request data in async code.`, r`Not clearing thread-local state.`, r`AsyncLocal sets in tight loops.`] },

{ id: 'q19', level: 'Senior', tags: ['memory-model', 'volatile', 'barriers', 'arm64'],
  q: r`What does the .NET memory model guarantee, what reorderings can happen on x64 vs ARM64, when do you need volatile, Volatile.Read/Write or a full barrier, and how do you implement double-checked locking correctly?`,
  a: r`### Who reorders
The C# compiler, the JIT (hoisting reads out of loops, caching in registers) and the **CPU** (store buffers, out-of-order execution). Single-threaded semantics are preserved; other threads can observe a different order.

### Hardware differences
- **x64** is strongly ordered: only store→load reordering is visible (a later read can pass an earlier write to a different location).
- **ARM64** (AWS Graviton, Azure Cobalt, Apple silicon) is **weakly ordered**: loads and stores can be reordered in more ways. Code that "always worked" on x64 with unsynchronised flags can break on ARM.

### The .NET guarantees (documented memory model, .NET 7+)
- Reads and writes of references and aligned primitives up to pointer size are atomic.
- **Volatile reads** have *acquire* semantics (later operations cannot move before them); **volatile writes** have *release* semantics (earlier operations cannot move after them).
- {{lock}}, {{Interlocked}}, {{Thread.MemoryBarrier()}} and Task/await hand-offs are **full fences**.
- Object publication: on .NET, writes in a constructor are visible before the reference is published to another thread through a normal write (the runtime ensures this on ARM), but relying on that for anything more complex than immutable objects is fragile.

### Tools
| Need | Use |
|---|---|
| a stop flag polled in a loop | {{volatile}} field or {{Volatile.Read}} |
| publish an immutable object | {{Volatile.Write}} / read with {{Volatile.Read}} |
| store then load of different variables must not reorder (Dekker-style) | full fence: {{Interlocked}} or {{Thread.MemoryBarrier}} |
| compound updates | {{lock}} or Interlocked |

### Double-checked locking
Correct form: a **volatile** (or Volatile.Read/Write) field, check, lock, check again, construct fully into a local, then publish. Better: use {{Lazy<T>}} ({{LazyThreadSafetyMode.ExecutionAndPublication}}) or {{LazyInitializer.EnsureInitialized}}, which encode it correctly.`,
  code: r`~~~csharp
// Stop flag: without volatile the JIT may hoist the read and spin forever
private volatile bool _stopping;
public void Stop() => _stopping = true;
void Loop() { while (!_stopping) Poll(); }

// Correct double-checked locking (prefer Lazy<T>)
private volatile RiskModel? _model;
private readonly Lock _gate = new();
public RiskModel Model
{
    get
    {
        var m = _model;                                   // volatile read (acquire)
        if (m is not null) return m;
        lock (_gate)
        {
            m = _model;
            if (m is null) { m = RiskModel.Load(); _model = m; }   // fully built before the volatile write (release)
            return m;
        }
    }
}

// Simpler and correct
private readonly Lazy<RiskModel> _lazyModel = new(RiskModel.Load, LazyThreadSafetyMode.ExecutionAndPublication);

// Store-load ordering needs a full fence (both threads must not miss each other's flag)
_iWantIn = 1;
Interlocked.MemoryBarrierProcessWide();   // or Thread.MemoryBarrier()
if (Volatile.Read(ref _otherWantsIn) == 0) EnterFastPath();
~~~`,
  pts: [r`Compiler, JIT and CPU reorder; only single-thread semantics are preserved.`, r`x64 is strongly ordered; ARM64 is weak: test on the hardware you deploy to.`, r`Volatile read = acquire, volatile write = release; locks and Interlocked are full fences.`, r`Store-then-load across variables needs a full fence.`, r`Use Lazy<T> or LazyInitializer instead of hand-written double-checked locking.`],
  ex: r`A matching-engine side service ported to Graviton instances started occasionally reading a "snapshot ready" flag as true before the snapshot's fields were visible, producing zero-priced quotes. On x64 the bug never showed. Publishing the snapshot as an immutable object via Volatile.Write fixed it, and ARM64 runs were added to the stress-test suite.`,
  fu: [r`Why is the volatile keyword not enough for a counter?`, r`What does the JIT do to a non-volatile field read inside a loop?`, r`Which .NET primitives already include full fences?`],
  pit: [r`Testing lock-free code only on x64.`, r`Hand-written double-checked locking without volatile.`, r`Using volatile as a substitute for locking compound operations.`] },

{ id: 'q20', level: 'Senior', tags: ['false-sharing', 'cache-lines', 'performance', 'counters'],
  q: r`What is false sharing, how do you detect it, and how do you design high-frequency counters and per-core state (striping, padding) in .NET?`,
  a: r`### Cache coherence in one paragraph
CPUs move memory in **cache lines** (64 bytes on x64 and most ARM64; 128 bytes effective on some, e.g. Apple M-series). When one core writes to a line, other cores' copies of that **whole line** are invalidated. If two threads write **different variables that share a line**, the line ping-pongs between cores: each write costs tens to hundreds of cycles instead of one. That is **false sharing**: no logical sharing, real hardware contention.

### Where it appears
- Arrays of per-thread counters ({{long[] counts}} indexed by worker id): 8 longs per line.
- Adjacent fields in one object written by different threads (a producer index next to a consumer index).
- A single global {{Interlocked.Increment}} counter hit by every core (true sharing, same effect).

### Fixes
- **Padding**: place hot fields on separate cache lines ({{[StructLayout(LayoutKind.Explicit, Size = 128)]}} or explicit padding fields).
- **Striping**: N counters (N ≥ cores), each thread writes its own stripe chosen by {{Thread.GetCurrentProcessorId()}} or a thread-local index; sum stripes on read. This is how high-throughput metrics libraries work.
- **Thread-local accumulation** with periodic merge (Parallel localInit/localFinally).
- Batch updates: increment a local counter, publish every N operations.

### Detection
Throughput that **drops as you add cores**, high CPU with low useful work, and in profilers high cycles on simple increments. Linux {{perf c2c}} identifies contended lines; BenchmarkDotNet with hardware counters shows cache misses. .NET's own {{System.Diagnostics.Metrics}} counters already use striping, which is a reason not to hand-roll metrics.`,
  code: r`~~~csharp
// False sharing: 8 workers' counters on the same cache line
long[] perWorker = new long[8];
Parallel.For(0, 8, w => { for (int i = 0; i < 100_000_000; i++) perWorker[w]++; });   // slow: line ping-pong

// Padded: each counter on its own 128-byte slot
[StructLayout(LayoutKind.Explicit, Size = 128)]
struct PaddedLong { [FieldOffset(64)] public long Value; }
var padded = new PaddedLong[8];
Parallel.For(0, 8, w => { for (int i = 0; i < 100_000_000; i++) padded[w].Value++; });  // several times faster

// Striped counter for a hot global metric
public sealed class StripedCounter
{
    private readonly PaddedLong[] _stripes = new PaddedLong[Environment.ProcessorCount * 2];
    public void Increment()
    {
        var i = Thread.GetCurrentProcessorId() % _stripes.Length;
        Interlocked.Increment(ref _stripes[i].Value);
    }
    public long Read()
    {
        long sum = 0;
        foreach (ref readonly var s in _stripes.AsSpan()) sum += Volatile.Read(ref Unsafe.AsRef(in s.Value));
        return sum;
    }
}

// Producer/consumer indices on separate lines
[StructLayout(LayoutKind.Explicit, Size = 192)]
struct RingIndices
{
    [FieldOffset(64)]  public long Head;   // written by consumer
    [FieldOffset(128)] public long Tail;   // written by producer
}
~~~`,
  pts: [r`Cache coherence works on whole lines: unrelated writes on one line contend.`, r`Per-thread arrays and adjacent hot fields are the usual culprits.`, r`Pad hot fields to separate lines; stripe counters per core.`, r`Throughput falling as cores increase is the symptom.`, r`Use built-in metrics (already striped) instead of hand-rolled global counters.`],
  ex: r`A market-data handler counted messages per feed in a long[] indexed by feed; scaling from 4 to 16 cores reduced throughput by 30%. Padding the counters to 128 bytes restored linear scaling, measured with BenchmarkDotNet and perf c2c on the production instance type.`,
  fu: [r`Why 128 bytes of padding rather than 64?`, r`How does Thread.GetCurrentProcessorId help, and why can it change mid-operation?`, r`Is a single Interlocked counter false sharing or true sharing?`],
  pit: [r`Per-thread counters in a dense array.`, r`Optimising without measuring on the production CPU.`, r`One global Interlocked counter on every request path.`] },

{ id: 'q21', level: 'Senior', tags: ['lock-contention', 'diagnostics', 'profiling'],
  q: r`CPU is at 35%, throughput has plateaued, and latency rises with load. How do you prove lock contention is the cause, find the lock, and reduce it?`,
  a: r`### Symptoms
Throughput stops scaling with load or cores; CPU is **not** saturated; p99 grows faster than p50; thread count may rise as threads block. (Thread-pool starvation looks similar; contention shows threads blocked in Monitor rather than in sync-over-async waits.)

### Proving it
1. **Counters**: {{dotnet-counters monitor -n app System.Runtime}} and watch **Monitor Lock Contention Count** per second. Hundreds or thousands per second on a request path is a signal.
2. **Trace**: {{dotnet-trace collect --providers Microsoft-Windows-DotNETRuntime:0x4000:4}} (contention keyword) or PerfView/Visual Studio concurrency profiling: **ContentionStart/Stop** events with stacks show *which* lock and how long threads wait.
3. **Dump**: {{dotnet-dump analyze}} → {{syncblk}} lists owned monitors and waiter counts; {{clrstack -all}} shows who holds and who waits.
4. **Continuous profilers** (Datadog, Pyroscope, Azure profiler) show "lock wait" time per stack in production.

### Reducing contention, in order
1. **Shrink the critical section**: move I/O, logging, allocation and serialisation out of the lock; copy data out and process outside.
2. **Remove the sharing**: per-request instances, immutable snapshots, thread-local accumulation.
3. **Split the lock** (striping by key hash), keeping lock ordering rules if a thread takes several.
4. **Change the structure**: ConcurrentDictionary, lock-free swaps, single-writer queues.
5. Read-mostly: copy-on-write instead of ReaderWriterLockSlim.

### Hidden locks
Logging sinks writing synchronously to a file, {{Console.WriteLine}} (locked), static {{Random}} wrapped in a lock, legacy caches, {{lock}} inside third-party libraries, and the GC's allocation contexts under extreme allocation rates.`,
  code: r`~~~bash
# 1. Is it contention?
dotnet-counters monitor -n Payments.Api --counters System.Runtime[monitor-lock-contention-count,threadpool-thread-count,cpu-usage]

# 2. Which lock? Collect contention events with stacks for 30 s
dotnet-trace collect -n Payments.Api --duration 00:00:30 \
  --providers Microsoft-Windows-DotNETRuntime:0x4000:4,Microsoft-DotNETCore-SampleProfiler

# 3. Who holds it right now?
dotnet-dump collect -n Payments.Api -o hang.dmp
dotnet-dump analyze hang.dmp -c "syncblk" -c "clrstack -all"
~~~
~~~csharp
// Before: I/O and serialisation inside the lock
lock (_gate)
{
    _positions[key] = updated;
    _log.LogInformation("Position {Key} = {Json}", key, JsonSerializer.Serialize(updated));   // slow, inside lock
    _auditWriter.Write(updated);                                                            // file I/O inside lock
}

// After: minimal critical section, side effects outside
Position snapshot;
lock (_gate) { _positions[key] = updated; snapshot = updated; }
_auditChannel.Writer.TryWrite(snapshot);                       // async writer drains elsewhere
_log.LogDebug("Position {Key} updated", key);

// Striped locks by key (when a single map must stay a plain Dictionary per stripe)
private readonly Lock[] _stripes = Enumerable.Range(0, 64).Select(_ => new Lock()).ToArray();
private Lock StripeFor(string key) => _stripes[(key.GetHashCode() & 0x7fffffff) % _stripes.Length];
~~~`,
  pts: [r`Plateaued throughput with spare CPU suggests contention or starvation.`, r`Monitor Lock Contention Count, ContentionStart events and syncblk prove it.`, r`Shrink critical sections first: no I/O, logging or serialisation inside.`, r`Then remove sharing, stripe, or change the data structure.`, r`Watch for hidden locks in loggers, Console and libraries.`],
  ex: r`A position service plateaued at 3,000 updates/s with 30% CPU. Contention traces showed 70% of wait time on one lock whose body serialised JSON for an Information log. Moving logging and audit out of the lock raised throughput to 21,000 updates/s on the same hardware.`,
  fu: [r`How do you tell contention from thread-pool starvation in counters?`, r`What is a lock convoy?`, r`How would you find contention in production without a debugger?`],
  pit: [r`Logging or I/O inside critical sections.`, r`Adding threads to fix contention.`, r`Fine-grained locks without an ordering rule.`] },

{ id: 'q22', level: 'Senior', tags: ['thread-pool-starvation', 'sync-over-async', 'incident', 'diagnostics'],
  q: r`Incident: after a deploy, p99 rises from 80 ms to 30 seconds under moderate load, CPU is at 15%, and health checks time out. Walk through diagnosing thread-pool starvation from counters and a dump, the fix, and prevention.`,
  a: r`### Recognise it
Latency climbs in steps while **CPU stays low**; **thread count grows slowly** (hill climbing adds threads gradually above the minimum); **queue length** grows; even trivial endpoints (health checks) are slow because their continuations wait in the queue. Often triggered by a deploy that added a blocking call, or by a dependency slowing down so existing blocking calls hold threads longer.

### Evidence
1. {{dotnet-counters}}: ThreadPool Queue Length high and rising, Thread Count climbing slowly, CPU low.
2. **Dump**: {{dotnet-dump collect}}, then {{clrstack -all}} or Visual Studio **Parallel Stacks**: hundreds of threads in {{Task.Wait}}, {{TaskAwaiter.GetResult}}, {{ManualResetEventSlim.Wait}}, {{Monitor.Wait}}, or synchronous socket/database calls. Group by top frames to find the common caller.
3. {{dumpasync}} shows async state machines waiting, to see what the blocked work is waiting for.

### Typical causes
- **Sync-over-async**: {{.Result}}, {{.Wait()}}, {{GetAwaiter().GetResult()}} on async I/O (often inside a constructor, a DI factory, a property, a logging sink or an authorization handler).
- **Synchronous I/O** APIs (sync DB calls, {{File.ReadAllText}} on network shares, sync Redis clients).
- Blocking waits on semaphores or locks for long periods.
- Long CPU work on request threads.

### Fix
- Make the path **async all the way**; for unavoidable sync APIs isolate them on a dedicated thread or bounded worker.
- **Stopgap**: {{ThreadPool.SetMinThreads}} (or {{System.Threading.ThreadPool.MinThreads}} in runtimeconfig) to absorb the blocking while the fix ships.

### Prevention
- Analyzers: {{VSTHRD002}} (avoid synchronous waits), {{CA1849}} (call async methods when in an async method), {{CA2012}} (ValueTask misuse).
- Alert on **queue length** and thread-count growth.
- Load tests with **injected dependency latency**: blocking bugs only appear when dependencies slow down.`,
  code: r`~~~csharp
// The hidden blocking call that caused it: an auth handler doing sync-over-async
public sealed class MerchantScopeHandler(IMerchantDirectory dir) : AuthorizationHandler<MerchantScopeRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext ctx, MerchantScopeRequirement req)
    {
        var merchant = dir.GetAsync(ctx.User.FindFirst("mid")!.Value).Result;       // blocks a pool thread per request
        if (merchant.IsActive) ctx.Succeed(req);
        return Task.CompletedTask;
    }
}

// Fixed: async all the way
protected override async Task HandleRequirementAsync(AuthorizationHandlerContext ctx, MerchantScopeRequirement req)
{
    var merchant = await dir.GetAsync(ctx.User.FindFirst("mid")!.Value);
    if (merchant.IsActive) ctx.Succeed(req);
}
~~~
~~~bash
dotnet-counters monitor -n Payments.Api --counters System.Runtime[threadpool-queue-length,threadpool-thread-count,cpu-usage]
dotnet-dump collect -n Payments.Api -o starve.dmp
dotnet-dump analyze starve.dmp -c "clrstack -all" | grep -E "Wait|GetResult" | sort | uniq -c | sort -rn | head
~~~
~~~xml
<!-- .editorconfig equivalents: make blocking waits a build error -->
<!-- dotnet_diagnostic.VSTHRD002.severity = error ; dotnet_diagnostic.CA1849.severity = error -->
~~~`,
  pts: [r`Low CPU, growing queue, slowly growing thread count, slow health checks = starvation.`, r`Dumps show many threads in Wait/GetResult; group stacks to find the caller.`, r`Causes: sync-over-async, sync I/O, long blocking waits.`, r`Fix async all the way; SetMinThreads only as a stopgap.`, r`Analyzers, queue-length alerts and latency-injection load tests prevent it.`],
  ex: r`A payments API began timing out after an authorization handler was added that called .Result on a merchant-directory lookup; under a 200 ms directory slowdown, 400 threads were blocked. A dump grouped by stack pointed straight at the handler; the async fix shipped in an hour, with SetMinThreads raised for that hour.`,
  fu: [r`Why does hill climbing add threads slowly?`, r`Why can health checks fail before real endpoints during starvation?`, r`Where else does sync-over-async hide (DI factories, IOptions validation, logging)?`],
  pit: [r`Scaling out pods instead of finding the blocking call.`, r`Leaving SetMinThreads as the permanent fix.`, r`Blocking calls inside DI factories and constructors.`] },

{ id: 'q23', level: 'Senior', tags: ['deadlocks', 'dotnet-dump', 'hang-analysis', 'async-deadlock'],
  q: r`A .NET service hangs in production: requests never complete, CPU is near zero. How do you capture and analyse the hang (sync deadlocks and async "deadlocks" with no threads blocked), and what do you change afterwards?`,
  a: r`### Capture
- {{dotnet-dump collect -p PID}} (works in containers with the diagnostics tools sidecar or {{DOTNET_DbgEnableMiniDump}} settings); take **two dumps 30 seconds apart** to see what is stuck vs moving.
- Kubernetes: exec into the pod or use a debug container; make sure the pod has write access to a volume for the dump.

### Synchronous deadlocks
- {{syncblk}}: monitors with an owner thread and waiters.
- {{clrstack -all}} / Parallel Stacks: thread A holds lock 1 and waits for lock 2 in {{Monitor.Enter}}; thread B the reverse.
- Also look for {{SemaphoreSlim.Wait}}, {{ManualResetEventSlim.Wait}} and database calls waiting on server-side locks (cross-check {{sys.dm_os_waiting_tasks}}).

### Async hangs (no thread is blocked)
Every thread is idle, yet requests never finish: some awaited Task never completes.
- {{dumpasync}} (in dotnet-dump) lists async state machines and what each awaits; follow the chain to the root.
- Typical roots: a **TaskCompletionSource never completed** on an error path; an async lock ({{SemaphoreSlim}}) never released because an exception skipped Release; a lost cancellation registration; a channel reader waiting on a writer that was never completed; awaiting a task that waits on itself through a lazy cache.

### Afterwards
- Fix the specific cycle (lock ordering, finally blocks, TrySet* on all paths).
- **Timeouts everywhere**: every await of an external dependency has a deadline; async locks use {{WaitAsync(timeout)}}; so a future hang becomes an error with a stack trace.
- Watchdogs: request duration alerts, a liveness probe that exercises a real code path (not just "return 200").
- Code-review rules for TCS completion, Release in finally, and lock ordering.`,
  code: r`~~~bash
dotnet-dump collect -p 1 -o /dumps/hang-1.dmp && sleep 30 && dotnet-dump collect -p 1 -o /dumps/hang-2.dmp
dotnet-dump analyze /dumps/hang-1.dmp
> syncblk                         # owned monitors and waiting threads
> clrstack -all                   # all managed stacks
> dumpasync --coalesce            # async state machines grouped by what they await
> dumpasync --stats
~~~
~~~csharp
// Root cause found by dumpasync: Release skipped on an exception path
await _gate.WaitAsync();
var data = await LoadAsync();          // throws -> Release never called -> every later caller awaits forever
_gate.Release();

// Fixed, and bounded so a future bug fails loudly
if (!await _gate.WaitAsync(TimeSpan.FromSeconds(10), ct))
    throw new TimeoutException("Gate not released within 10 s");
try { var data2 = await LoadAsync(); }
finally { _gate.Release(); }

// Liveness that exercises a real path, not a constant 200
app.MapHealthChecks("/health/live", new() { Predicate = r => r.Tags.Contains("live") });
builder.Services.AddHealthChecks().AddCheck<InternalPipelineCheck>("pipeline", tags: ["live"]);
~~~`,
  pts: [r`Take two dumps apart; compare what is stuck.`, r`syncblk and clrstack for lock cycles; Parallel Stacks to group threads.`, r`Async hangs: no blocked threads; use dumpasync to find the never-completing task.`, r`Common roots: uncompleted TCS, skipped Release, uncompleted channels.`, r`Add timeouts everywhere so hangs become errors; meaningful liveness checks.`],
  ex: r`A settlement service stopped processing every few days with zero CPU and no exceptions; restarts "fixed" it. dumpasync showed 2,000 state machines awaiting one SemaphoreSlim whose Release was skipped when a rare exception occurred. A finally block plus WaitAsync timeouts ended the hangs.`,
  fu: [r`How do you capture a dump from a distroless container?`, r`How do you tell an async hang from a slow dependency?`, r`What would a liveness probe that detects this look like?`],
  pit: [r`Restarting without capturing a dump.`, r`Liveness probes that do nothing.`, r`Awaits with no deadline on external calls.`] },

{ id: 'q24', level: 'Senior', tags: ['async-coordination', 'single-flight', 'async-lazy', 'caching'],
  q: r`Implement async coordination patterns correctly: an AsyncLazy, a per-key single-flight cache that prevents stampedes, and an async lock keyed by entity, including failure handling and memory cleanup.`,
  a: r`### AsyncLazy
{{Lazy<Task<T>>}} gives a once-only asynchronous initialisation. Problems: a **faulted** task is cached forever, and the factory runs on whichever caller arrives first (with its cancellation token). Fix: reset on failure, and do not pass a caller's token into a shared initialisation (or use a dedicated token).

### Single-flight (stampede protection)
When a hot cache entry expires, 1,000 concurrent requests all miss and call the backend. **Single-flight**: the first caller starts the load and stores its **Task** in a {{ConcurrentDictionary<key, Lazy<Task<T>>>}}; others await the same task; remove the entry when it completes. Combine with:
- **Soft expiry / refresh-ahead**: serve the stale value while one caller refreshes.
- **Jittered TTLs** so many keys do not expire together.
.NET 9 {{HybridCache}} implements stampede protection for in-memory plus distributed caching.

### Per-key async lock
Serialise operations per account while allowing different accounts in parallel: a dictionary of {{SemaphoreSlim}} per key with **reference counting** so entries are removed when unused; otherwise the dictionary grows with every account ever seen. Alternatives: hash keys into a fixed array of N semaphores (bounded memory, some false serialisation), or a partitioned channel per key-hash (see per-key ordering).

### Failure handling
- Never cache failures longer than intended; remove failed entries.
- A shared task's cancellation should not be one caller's token.
- Always release in finally; time-bound waits.`,
  code: r`~~~csharp
// Single-flight loader: concurrent callers for the same key share one backend call
public sealed class SingleFlight<TKey, TValue> where TKey : notnull
{
    private readonly ConcurrentDictionary<TKey, Lazy<Task<TValue>>> _inflight = new();

    public async Task<TValue> GetAsync(TKey key, Func<TKey, Task<TValue>> load)
    {
        var lazy = _inflight.GetOrAdd(key, k => new Lazy<Task<TValue>>(() => load(k)));
        try { return await lazy.Value; }
        finally { _inflight.TryRemove(new KeyValuePair<TKey, Lazy<Task<TValue>>>(key, lazy)); }   // remove only our entry
    }
}

// Per-key async lock with reference counting (no unbounded growth)
public sealed class KeyedLock<TKey> where TKey : notnull
{
    private sealed class Entry { public readonly SemaphoreSlim Sem = new(1, 1); public int Refs; }
    private readonly Dictionary<TKey, Entry> _entries = new();
    private readonly Lock _gate = new();

    public async Task<IDisposable> AcquireAsync(TKey key, CancellationToken ct)
    {
        Entry e;
        lock (_gate) { if (!_entries.TryGetValue(key, out e!)) _entries[key] = e = new Entry(); e.Refs++; }
        try { await e.Sem.WaitAsync(ct); }
        catch { Release(key, e, acquired: false); throw; }
        return new Releaser(() => Release(key, e, acquired: true));
    }

    private void Release(TKey key, Entry e, bool acquired)
    {
        if (acquired) e.Sem.Release();
        lock (_gate) { if (--e.Refs == 0) _entries.Remove(key); }
    }
    private sealed class Releaser(Action a) : IDisposable { public void Dispose() => a(); }
}

// Usage: serialise per account, parallel across accounts
using (await _accountLocks.AcquireAsync(accountId, ct))
    await ApplyAsync(accountId, command, ct);

// .NET 9 HybridCache: stampede protection built in
var limits = await hybridCache.GetOrCreateAsync($"limits:{merchantId}",
    async token => await limitsApi.GetAsync(merchantId, token),
    new HybridCacheEntryOptions { Expiration = TimeSpan.FromMinutes(5) }, cancellationToken: ct);
~~~`,
  pts: [r`Lazy<Task<T>> caches failures forever: reset on fault.`, r`Single-flight shares one in-flight task per key, then removes it.`, r`Refresh-ahead and jittered TTLs reduce stampedes; HybridCache does it for you.`, r`Per-key locks need reference counting or a fixed stripe array.`, r`Do not tie shared work to one caller's cancellation token.`],
  ex: r`When a merchant-limits cache entry expired at 09:00, 4,000 authorisations missed simultaneously and called the limits service, which fell over and caused declines for six minutes. Single-flight loading and refresh-ahead turned that into one call per merchant per refresh.`,
  fu: [r`What happens in your single-flight if the load throws?`, r`How does refresh-ahead avoid serving very stale data?`, r`Fixed stripe array vs reference-counted dictionary: trade-offs?`],
  pit: [r`Caching faulted tasks.`, r`Unbounded dictionaries of per-key semaphores.`, r`Passing the first caller's token into a shared load.`] },

{ id: 'q25', level: 'Senior', tags: ['task-composition', 'exceptions', 'structured-concurrency'],
  q: r`Structured concurrency in .NET: how do you compose tasks with WhenAll, WhenAny and Task.WhenEach (.NET 9) so that every task is awaited, failures are observed, siblings are cancelled, and nothing runs orphaned after the request ends?`,
  a: r`.NET has no built-in structured-concurrency scope, so you enforce the rules yourself:
1. **Every started task is awaited** by its starter (or handed to an owner that awaits it).
2. **Child work cannot outlive the parent**: a linked CTS cancels siblings when one fails or the parent is cancelled.
3. **All failures are observed**.

### WhenAll
Completes when **all** tasks complete. {{await Task.WhenAll(...)}} rethrows **only the first** exception; the others are in {{whenAllTask.Exception.InnerExceptions}}. It does **not** cancel siblings on the first failure: pair it with a linked CTS that you cancel on failure.

### WhenAny
Returns the first completed task (which may be faulted). The losers keep running: cancel and **await** them (or at least observe their exceptions). Used for hedged requests and timeouts.

### Task.WhenEach (.NET 9)
{{await foreach (var t in Task.WhenEach(tasks))}} yields tasks as they complete: process results as they arrive (for example, show the first quotes while slower venues respond).

### Fire-and-forget
A task nobody awaits: its exception becomes an **unobserved task exception** (raised on {{TaskScheduler.UnobservedTaskException}} at finalisation, otherwise ignored), and the work may run after the request scope (and its DbContext) is disposed. Hand it to an owner instead: a {{Channel}} drained by a {{BackgroundService}}, or a tracked task collection awaited at shutdown.

### async void
Only for event handlers. An exception in async void is raised on the SynchronizationContext or the thread pool and **crashes the process**.`,
  code: r`~~~csharp
// Fan out to venues, cancel siblings on first failure, surface all errors
public async Task<IReadOnlyList<Quote>> GetBestQuotesAsync(IEnumerable<IVenue> venues, CancellationToken ct)
{
    using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    var tasks = venues.Select(async v =>
    {
        try { return await v.QuoteAsync(cts.Token); }
        catch { cts.Cancel(); throw; }                                 // fail fast: cancel siblings
    }).ToList();

    var all = Task.WhenAll(tasks);
    try { return await all; }
    catch when (all.Exception is { InnerExceptions.Count: > 1 } agg)
    {
        throw new AggregateException("Multiple venues failed", agg.InnerExceptions);   // keep every failure
    }
}

// Hedged request: first good answer wins, losers cancelled and observed
using var hedge = CancellationTokenSource.CreateLinkedTokenSource(ct);
var primary = replicaA.GetAsync(key, hedge.Token);
var delayed = Task.Delay(50, ct).ContinueWith(_ => replicaB.GetAsync(key, hedge.Token), ct).Unwrap();
var winner = await Task.WhenAny(primary, delayed);
hedge.Cancel();
_ = Task.WhenAll(primary, delayed).ContinueWith(t => _ = t.Exception, TaskScheduler.Default);   // observe losers
var value = await winner;

// .NET 9: process results as they complete
await foreach (var done in Task.WhenEach(tasks))
{
    if (done.IsCompletedSuccessfully) ui.Show(done.Result);
}

// Last-resort visibility for anything unobserved
TaskScheduler.UnobservedTaskException += (_, e) => { log.LogError(e.Exception, "Unobserved task exception"); e.SetObserved(); };
~~~`,
  pts: [r`Every task awaited by an owner; children do not outlive parents; failures observed.`, r`await WhenAll rethrows one exception; read Task.Exception for all.`, r`WhenAll does not cancel siblings: link a CTS and cancel on failure.`, r`WhenAny losers keep running: cancel and observe them; WhenEach streams completions.`, r`Fire-and-forget goes through an owned queue; async void only for event handlers.`],
  ex: r`A quote aggregator used WhenAll across 12 venues without cancellation; when one venue hung, every request waited the full 30-second timeout while the other 11 answers sat ready. Linked cancellation plus WhenEach streaming showed quotes as they arrived and failed the slow venue at its own 500 ms budget.`,
  fu: [r`Why does await WhenAll throw only the first exception?`, r`How do you make fire-and-forget work survive a pod shutdown?`, r`What is a hedged request and when is it worth the extra load?`],
  pit: [r`Ignoring the losers of WhenAny.`, r`Fire-and-forget tasks using scoped services after the request ends.`, r`async void outside event handlers.`] },

{ id: 'q26', level: 'Senior', tags: ['taskcompletionsource', 'ivaluetasksource', 'interop', 'request-response'],
  q: r`You must expose an async request/response API over a messaging connection that delivers replies on a callback (correlation by id). Build it with TaskCompletionSource, handle timeouts, cancellation and disconnects, and explain when IValueTaskSource is worth it.`,
  a: r`### Design
- A {{ConcurrentDictionary<correlationId, TaskCompletionSource<Reply>>}} of pending requests.
- **Send**: create the TCS with {{RunContinuationsAsynchronously}}, register it, send the message, then await the TCS task with a timeout.
- **Receive callback**: look up and **remove** the TCS by correlation id, {{TrySetResult}}. Unknown ids (late replies after a timeout) are logged and dropped.
- **Timeout / cancellation**: a linked token that, when fired, removes the entry and {{TrySetCanceled}} or sets a timeout exception. Dispose the registration when done.
- **Disconnect**: fail **all** pending TCS instances with a connection exception, otherwise callers hang forever.
- Bound the number of pending requests (backpressure) so a stuck peer cannot grow the dictionary without limit.

### Why RunContinuationsAsynchronously
The receive callback is usually the socket's read loop; inline continuations would run caller code on it and stall all other replies.

### IValueTaskSource
Every request allocates a TCS and its Task. At very high rates (hundreds of thousands per second) you can pool the completion object with {{ManualResetValueTaskSourceCore<T>}} behind an {{IValueTaskSource<T>}} and return {{ValueTask<T>}}. The rules get strict: a ValueTask from a pooled source may be **awaited exactly once**, never concurrently, never after it is returned to the pool. Kestrel, sockets and Channels do this internally. For most services the allocation is not the bottleneck: measure before adopting.`,
  code: r`~~~csharp
public sealed class RpcClient(IMessageConnection conn, ILogger<RpcClient> log)
{
    private readonly ConcurrentDictionary<Guid, TaskCompletionSource<Reply>> _pending = new();
    private readonly SemaphoreSlim _slots = new(5_000);                     // bound outstanding requests

    public async Task<Reply> CallAsync(Request req, TimeSpan timeout, CancellationToken ct)
    {
        if (!await _slots.WaitAsync(TimeSpan.FromSeconds(1), ct)) throw new BulkheadRejectedException("rpc");
        var id = Guid.NewGuid();
        var tcs = new TaskCompletionSource<Reply>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        try
        {
            await conn.SendAsync(req with { CorrelationId = id }, ct);
            return await tcs.Task.WaitAsync(timeout, ct);                  // TimeoutException or OperationCanceledException
        }
        finally
        {
            _pending.TryRemove(id, out _);                                  // late replies will be dropped
            _slots.Release();
        }
    }

    // Called on the connection's receive loop
    public void OnReply(Reply reply)
    {
        if (_pending.TryRemove(reply.CorrelationId, out var tcs)) tcs.TrySetResult(reply);
        else log.LogDebug("Late or unknown reply {Id}", reply.CorrelationId);
    }

    // Called when the connection drops: never leave callers hanging
    public void OnDisconnected(Exception reason)
    {
        foreach (var (id, tcs) in _pending)
            if (_pending.TryRemove(id, out _)) tcs.TrySetException(new ConnectionLostException(reason));
    }
}
~~~`,
  pts: [r`Pending map of correlation id to TCS; remove on reply, timeout or cancel.`, r`RunContinuationsAsynchronously keeps the receive loop free.`, r`Fail every pending request on disconnect.`, r`Bound outstanding requests for backpressure.`, r`IValueTaskSource pooling only for measured hot paths, with await-once rules.`],
  ex: r`An internal pricing RPC over a message bus leaked pending entries whenever a reply was lost; after a week a pod held 3 million TCS objects and callers waited forever after a broker failover. Timeout-based removal and failing all pending requests on disconnect fixed both.`,
  fu: [r`What happens if a reply arrives just after the timeout fired?`, r`Why must a pooled ValueTask be awaited only once?`, r`How would you add per-request deadlines propagated to the server?`],
  pit: [r`No removal path for timed-out requests.`, r`Inline continuations on the receive thread.`, r`Pending requests left hanging on disconnect.`] },

{ id: 'q27', level: 'Senior', tags: ['rate-limiting', 'bulkhead', 'concurrency-limits', 'backpressure'],
  q: r`Protect a fragile downstream dependency and your own service: concurrency limits vs rate limits, System.Threading.RateLimiting (token bucket, sliding window, concurrency, partitioned), bulkheads and queueing. How do you choose limits?`,
  a: r`### Two different limits
- **Concurrency limit**: at most N operations **in flight**. Protects resources whose cost scales with simultaneous work (connections, threads, memory, a database).
- **Rate limit**: at most N operations **per time window**. Matches contractual quotas (a partner allows 100 req/s) and fairness between clients.

### System.Threading.RateLimiting (.NET 7+)
| Limiter | Use |
|---|---|
| {{ConcurrencyLimiter}} | bulkhead for a dependency |
| {{TokenBucketRateLimiter}} | steady rate with bursts |
| {{FixedWindowRateLimiter}} / {{SlidingWindowRateLimiter}} | quota per window |
| {{PartitionedRateLimiter}} | per tenant, per API key, per IP |
| chained limiters | combine (per-tenant rate + global concurrency) |
All support a **queue limit** and order ({{QueueProcessingOrder.OldestFirst}}); the same types back ASP.NET Core's rate-limiting middleware.

### Queueing is a decision
A small queue absorbs bursts; a large queue just adds latency and hides overload. Prefer **fail fast** (429/503 with Retry-After) once the queue is short-full: callers can retry elsewhere or later.

### Choosing numbers
- Concurrency for a dependency: **Little's Law** from its capacity: if it handles 200 req/s at 50 ms, about 10 in flight per instance of you (divided across your replicas).
- Rate limits from contracts, divided by replicas, or enforced centrally (Redis) if precision matters.
- Revisit with metrics: rejected count, queue wait time, dependency latency.
- **Adaptive** limits (AIMD, gradient algorithms) adjust to observed latency; useful when capacity changes.

### Where
Inbound per-tenant fairness at the edge (gateway/middleware); outbound bulkheads per dependency in the client (HttpClient handler); separate limits so one slow dependency cannot consume all threads or connections.`,
  code: r`~~~csharp
// Outbound bulkhead + partner rate limit as a DelegatingHandler
public sealed class PartnerLimitsHandler : DelegatingHandler
{
    private readonly RateLimiter _rate = new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
    { TokenLimit = 20, TokensPerPeriod = 25, ReplenishmentPeriod = TimeSpan.FromMilliseconds(250), QueueLimit = 50 });   // ~100/s, bursts of 20
    private readonly RateLimiter _concurrency = new ConcurrencyLimiter(new ConcurrencyLimiterOptions
    { PermitLimit = 10, QueueLimit = 20, QueueProcessingOrder = QueueProcessingOrder.OldestFirst });

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        using var rateLease = await _rate.AcquireAsync(1, ct);
        if (!rateLease.IsAcquired) throw new BulkheadRejectedException("partner rate limit");
        using var slot = await _concurrency.AcquireAsync(1, ct);
        if (!slot.IsAcquired) throw new BulkheadRejectedException("partner concurrency limit");
        return await base.SendAsync(req, ct);
    }
}

// Inbound per-tenant fairness (ASP.NET Core middleware)
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("per-tenant", ctx => RateLimitPartition.GetSlidingWindowLimiter(
        ctx.User.FindFirst("tid")?.Value ?? "anon",
        _ => new SlidingWindowRateLimiterOptions { PermitLimit = 600, Window = TimeSpan.FromMinutes(1), SegmentsPerWindow = 6, QueueLimit = 0 }));
});
app.MapPost("/payments", CreatePayment).RequireRateLimiting("per-tenant");
~~~`,
  pts: [r`Concurrency limits protect in-flight resources; rate limits enforce per-time quotas.`, r`RateLimiting library: concurrency, token bucket, windows, partitioned, chained.`, r`Small queues, then fail fast with 429/503 and Retry-After.`, r`Size with Little's Law and contracts; divide by replicas or centralise.`, r`Separate bulkheads per dependency; per-tenant fairness at the edge.`],
  ex: r`A KYC partner allowed 50 concurrent requests across all our pods; without limits, a batch re-screening job used them all and onboarding stalled for six hours. A per-pod concurrency limiter sized from the partner's limit divided by replicas, plus a lower-priority partition for batch work, kept onboarding responsive.`,
  fu: [r`How do you enforce a global rate limit across 20 replicas?`, r`When is an adaptive concurrency limit better than a fixed one?`, r`What should clients do with a 429 and Retry-After?`],
  pit: [r`Large queues that hide overload.`, r`One shared limit for all dependencies.`, r`Per-pod limits that ignore replica count.`] },

{ id: 'q28', level: 'Senior', tags: ['ordering', 'partitioning', 'per-key-processing', 'kafka'],
  q: r`Process 20,000 account events per second concurrently while guaranteeing events for the same account are applied in order. Design the in-process concurrency and its mapping to Kafka partitions.`,
  a: r`### The principle
**Parallelism across keys, sequence within a key.** Never run two events of the same account concurrently; run different accounts on different workers.

### In-process design: partitioned workers
- N workers, each owning a **bounded Channel**.
- Route by {{hash(accountId) % N}}: all events for an account go to the same worker, which processes them sequentially.
- N is set by throughput needs and downstream capacity, not by account count.
- Skew: one very hot account limits its worker; mitigate with more partitions, or redesign that account (batching, sub-ledgers).

### Mapping to Kafka
- Produce with the **account id as the key** so all its events land in one partition (Kafka preserves order per partition).
- A consumer instance handles several partitions; inside it, fan out to the partitioned workers keyed by account (finer-grained than partitions, more parallelism).
- **Commit offsets carefully**: an offset can be committed only when all earlier events in that partition are processed. Track per-partition the highest **contiguous** completed offset.
- Rebalances: on partition revocation, drain or abandon in-flight work for those partitions before giving them up, otherwise the new owner reprocesses (idempotency covers duplicates).

### Alternatives
- **Keyed locks** with a shared worker pool: simpler, but order is only guaranteed if events are dispatched to the lock in order (a lock does not order waiters).
- **Actors** (Orleans grain per account): the runtime gives per-key sequential processing.
- TPL Dataflow with one ActionBlock per partition.

### Must-haves
Idempotent handlers (redelivery after crash), per-key retry that **blocks that key** (not others) or parks it to a retry topic with ordering consequences understood, and metrics on per-worker queue depth.`,
  dia: r`flowchart LR
  K[(Kafka topic keyed by accountId)] --> C[Consumer instance: partitions 0..5]
  C --> R{hash accountId mod N}
  R --> W1[Worker 1 channel: sequential]
  R --> W2[Worker 2 channel: sequential]
  R --> W3[Worker N channel: sequential]
  W1 --> T[Offset tracker: contiguous completed per partition]
  W2 --> T
  W3 --> T
  T --> CM[Commit offsets]`,
  code: r`~~~csharp
public sealed class PartitionedProcessor
{
    private readonly Channel<Envelope>[] _lanes;
    private readonly Task[] _workers;

    public PartitionedProcessor(int lanes, Func<Envelope, CancellationToken, Task> handle, CancellationToken stop)
    {
        _lanes = Enumerable.Range(0, lanes)
            .Select(_ => Channel.CreateBounded<Envelope>(new BoundedChannelOptions(1_000) { SingleReader = true }))
            .ToArray();
        _workers = _lanes.Select(lane => Task.Run(async () =>
        {
            await foreach (var e in lane.Reader.ReadAllAsync(stop))
                await handle(e, stop);                                   // sequential per lane = per account
        })).ToArray();
    }

    public ValueTask EnqueueAsync(Envelope e, CancellationToken ct)
    {
        var lane = (int)((uint)StableHash(e.AccountId) % (uint)_lanes.Length);   // stable hash, not string.GetHashCode
        return _lanes[lane].Writer.WriteAsync(e, ct);                            // backpressure per lane
    }

    private static int StableHash(string s) => (int)System.IO.Hashing.XxHash32.HashToUInt32(Encoding.UTF8.GetBytes(s));
}

// Offset tracking: commit only the highest contiguous completed offset per partition
public sealed class OffsetTracker
{
    private readonly SortedSet<long> _done = new(); private long _committed = -1; private readonly Lock _gate = new();
    public long? Complete(long offset)
    {
        lock (_gate)
        {
            _done.Add(offset);
            var next = _committed + 1; var advanced = false;
            while (_done.Remove(next)) { _committed = next++; advanced = true; }
            return advanced ? _committed + 1 : null;                     // Kafka commits the next offset to read
        }
    }
}
~~~`,
  pts: [r`Parallel across keys, sequential within a key.`, r`Route by stable hash to N bounded lanes, each consumed sequentially.`, r`Kafka key = account id; commit only contiguous completed offsets.`, r`Handle rebalances and make handlers idempotent.`, r`Per-key retries block only that key; watch lane depth and hot-key skew.`],
  ex: r`A balance service processed Kafka events with 32 unordered consumer tasks; occasionally a debit was applied before the credit that funded it, triggering false overdraft fees. Hash-partitioned lanes by account id fixed ordering while keeping throughput at 25,000 events/s.`,
  fu: [r`Why not use string.GetHashCode for routing?`, r`How do you handle a poison event without blocking its account forever?`, r`What happens to ordering when you increase the number of Kafka partitions?`],
  pit: [r`Unordered parallel consumers for stateful per-key processing.`, r`Committing offsets for events not yet processed.`, r`Assuming a lock orders its waiters.`] },

{ id: 'q29', level: 'Senior', tags: ['actor-model', 'orleans', 'akka', 'single-threaded'],
  q: r`When does the actor model (Orleans grains, Akka.NET) beat locks and shared state? Explain turn-based concurrency, reentrancy, placement and persistence, using an account or order-book example.`,
  a: r`### The model
An **actor** owns its state privately and processes **one message at a time** (a turn). No locks inside: concurrency comes from many actors running in parallel, not from threads inside one actor. Communication is by asynchronous messages.

### Orleans (virtual actors)
- **Grains** are addressed by identity ({{IAccountGrain}} with key accountId) and activated on demand on some silo; the runtime guarantees a **single activation** per id in the cluster (best effort under partitions) and handles placement and failover.
- **Turn-based**: by default a grain is **non-reentrant**: while awaiting inside a method, other calls to that grain wait. {{[Reentrant]}} or {{[AlwaysInterleave]}} allow interleaving at awaits, reintroducing interleaving hazards (state can change across an await).
- **Persistence**: grain state is loaded on activation and written explicitly ({{WriteStateAsync}}); storage providers (Azure Table, SQL, Cosmos).
- Deadlocks: grain A calls B while B calls A (non-reentrant) → both wait until timeout. Avoid call cycles or mark specific methods reentrant.

### Akka.NET
Classic actors with mailboxes, supervision hierarchies (let-it-crash), clustering and sharding (Cluster Sharding is similar to virtual actors), persistence via event sourcing.

### When actors fit
- Many independent entities with frequent concurrent operations on each (accounts, carts, devices, game sessions, order books per instrument).
- Stateful, low-latency logic where a database round trip per operation is too slow.
- Per-key sequential processing without building partitioned workers yourself.

### When not
- CRUD over a relational model where the database already provides transactions.
- Cross-entity atomic invariants (transfer between two accounts): needs a saga or a transaction coordinator.
- Teams unfamiliar with the operational model (cluster membership, activation, state versioning).`,
  code: r`~~~csharp
public interface IAccountGrain : IGrainWithStringKey
{
    Task<DebitResult> DebitAsync(decimal amount, string idempotencyKey);
    Task<decimal> GetBalanceAsync();
}

public sealed class AccountGrain([PersistentState("account", "ledgerStore")] IPersistentState<AccountState> state)
    : Grain, IAccountGrain
{
    // Non-reentrant by default: one call at a time per account, no locks needed
    public async Task<DebitResult> DebitAsync(decimal amount, string key)
    {
        if (state.State.AppliedKeys.Contains(key)) return DebitResult.AlreadyApplied;   // idempotent
        if (state.State.Balance < amount) return DebitResult.InsufficientFunds;
        state.State.Balance -= amount;
        state.State.AppliedKeys.Add(key);
        await state.WriteStateAsync();                 // persisted before acknowledging
        return DebitResult.Ok;
    }

    [AlwaysInterleave]                                  // safe: read-only, may interleave with a pending debit
    public Task<decimal> GetBalanceAsync() => Task.FromResult(state.State.Balance);
}

// Caller: the runtime routes to the single activation for this account
var account = grainFactory.GetGrain<IAccountGrain>(accountId);
var result = await account.DebitAsync(80m, idempotencyKey);
~~~`,
  pts: [r`Actors own state and process one message at a time: no locks inside.`, r`Orleans grains are virtual: single activation per id, placed and recovered by the runtime.`, r`Non-reentrant by default; reentrancy reintroduces interleaving across awaits.`, r`Call cycles between non-reentrant grains deadlock until timeout.`, r`Fit: many hot independent entities; poor fit: cross-entity atomicity and plain CRUD.`],
  ex: r`A digital-wallet platform moved per-wallet balance logic from SQL row locks to Orleans grains; p99 debit latency fell from 45 ms to 4 ms and hot-wallet contention disappeared. Transfers between wallets were implemented as sagas, which the team found was the hardest part of the migration.`,
  fu: [r`What guarantees does Orleans give about single activation during a network partition?`, r`How do you version grain state?`, r`How would you implement a transfer between two account grains?`],
  pit: [r`Marking grains reentrant without reasoning about state across awaits.`, r`Cyclic grain calls.`, r`Assuming actors give cross-entity transactions.`] },

{ id: 'q30', level: 'Senior', tags: ['tpl-dataflow', 'pipelines', 'channels'],
  q: r`Build a multi-stage processing pipeline (parse, enrich via HTTP, validate, batch-write to a database). Compare TPL Dataflow with hand-written Channels pipelines: bounded capacity, parallelism per stage, ordering, completion and error propagation.`,
  a: r`### TPL Dataflow blocks
- {{TransformBlock<TIn,TOut>}}, {{ActionBlock<T>}}, {{BatchBlock<T>}}, {{BufferBlock<T>}}, {{BroadcastBlock<T>}}, {{TransformManyBlock}}.
- Per block: {{MaxDegreeOfParallelism}} (CPU stages ≈ cores, I/O stages = dependency capacity), {{BoundedCapacity}} (backpressure: {{SendAsync}} waits when full), {{EnsureOrdered}} (default true: outputs keep input order even with parallelism, at a buffering cost).
- {{LinkTo(target, new DataflowLinkOptions { PropagateCompletion = true })}} chains blocks; {{Complete()}} on the head flows to the tail; await the last block's {{Completion}}.
- A faulted block **faults the pipeline** (with PropagateCompletion) and drops queued items: catch per item inside stages and route failures to a dead-letter block if items must not be lost.

### Channels pipeline
Stages are tasks connected by bounded channels; you write the loops, parallelism (N readers per stage), ordering and completion yourself. More code, full control, fewer surprises, and better performance for simple linear pipelines.

### Choosing
| Need | Pick |
|---|---|
| linear pipeline, few stages, max throughput | Channels |
| branching, broadcast, joins, batching, per-stage parallelism with ordering | Dataflow |
| per-key ordering | partitioned lanes (either) |
| durability | neither alone: source from Kafka/queue and ack after the final stage |

### Common bugs
Unbounded blocks (the default BoundedCapacity is unbounded), using {{Post}} (returns false when full and the item is silently lost) instead of {{SendAsync}}, forgetting PropagateCompletion so the pipeline never finishes, and exceptions faulting the whole pipeline.`,
  code: r`~~~csharp
var opts = new DataflowLinkOptions { PropagateCompletion = true };

var parse = new TransformBlock<string, Payment?>(line => Payment.TryParse(line),
    new ExecutionDataflowBlockOptions { BoundedCapacity = 5_000, MaxDegreeOfParallelism = Environment.ProcessorCount });

var enrich = new TransformBlock<Payment?, Payment?>(async p =>
{
    if (p is null) return null;
    try { return p with { Merchant = await merchants.GetAsync(p.MerchantId) }; }
    catch (Exception ex) { await deadLetters.SendAsync((p, ex)); return null; }       // do not fault the pipeline
}, new ExecutionDataflowBlockOptions { BoundedCapacity = 2_000, MaxDegreeOfParallelism = 32, EnsureOrdered = false });

var batch = new BatchBlock<Payment>(500, new GroupingDataflowBlockOptions { BoundedCapacity = 5_000 });

var write = new ActionBlock<Payment[]>(rows => repository.BulkInsertAsync(rows),
    new ExecutionDataflowBlockOptions { BoundedCapacity = 4, MaxDegreeOfParallelism = 2 });

parse.LinkTo(enrich, opts);
enrich.LinkTo(batch, opts, p => p is not null);
enrich.LinkTo(DataflowBlock.NullTarget<Payment?>());          // discard nulls (already dead-lettered)
batch.LinkTo(write, opts);

await foreach (var line in file.ReadLinesAsync(ct))
    await parse.SendAsync(line, ct);                            // waits when full; Post would drop silently
parse.Complete();
await write.Completion;                                         // flushes the final partial batch
~~~`,
  pts: [r`Dataflow: blocks with per-stage parallelism, bounded capacity and optional ordering.`, r`PropagateCompletion and awaiting the tail's Completion end the pipeline.`, r`Exceptions fault the pipeline: catch per item and dead-letter.`, r`Use SendAsync, not Post, with bounded blocks.`, r`Channels for simple linear pipelines; Dataflow for graphs, batching and broadcast.`],
  ex: r`A statement-import pipeline built with Dataflow used Post into bounded blocks; under load Post returned false and 1.2% of lines were silently dropped, found only by reconciliation. Switching to SendAsync and adding a count check between input and output closed the gap.`,
  fu: [r`What does EnsureOrdered cost when one item is slow?`, r`How do you get per-key ordering with a parallel Dataflow stage?`, r`How do you make the pipeline resumable after a crash?`],
  pit: [r`Unbounded blocks.`, r`Post instead of SendAsync.`, r`Missing PropagateCompletion.`] },

{ id: 'q31', level: 'Senior', tags: ['distributed-locks', 'leases', 'fencing-tokens', 'redis', 'sql-server'],
  q: r`In-process locks do not work across 12 pods. When do you need a distributed lock, how do SQL Server sp_getapplock, Redis locks (and the Redlock debate), leases and fencing tokens work, and what is usually a better design?`,
  a: r`### First ask: do you need a lock at all?
Most "only one pod may do X" problems are better solved by:
- **Unique constraints / idempotency keys** (only one insert of a payment per key succeeds).
- **Atomic conditional updates** ({{UPDATE ... WHERE Status = 'Due'}}, rows affected tells you who won).
- **Partitioning** (Kafka partition ownership, one consumer per key range).
- A **scheduler** with built-in clustering for singleton jobs.

### When a lock is genuinely needed
Mutual exclusion around a side effect outside your database (calling a partner API exactly once per batch), or leader election for a singleton process.

### Options
| Mechanism | Properties |
|---|---|
| {{sp_getapplock}} (SQL Server) / {{pg_advisory_lock}} (PostgreSQL) | lock tied to a session or transaction: released automatically if the connection dies; strong consistency of the database; holding a connection for the lock duration |
| **Database lease row** ({{OwnerId}}, {{LeaseUntil}}) | claim with a guarded UPDATE; renew periodically; expires if the owner dies |
| **Redis** {{SET key value NX PX ttl}} | fast; release only if the value is still yours (Lua script); single-node Redis failover can lose the lock |
| **Redlock** (majority of N Redis nodes) | debated: Kleppmann showed GC pauses and clock jumps can let two holders act; safe only with fencing |
| ZooKeeper / etcd / Consul | consensus-based leases with watch semantics |

### The fundamental problem: process pauses
A holder can pause (GC, VM freeze, network partition) **past its lease expiry**, another node takes the lock, then the first resumes and acts. No lock service alone prevents this. The fix is a **fencing token**: a monotonically increasing number issued with each lock grant; the **protected resource** rejects writes carrying an older token than it has seen.

### Rule
Use the database you already trust (applock or lease rows), keep leases short with renewal, make protected operations **idempotent**, and add fencing where the downstream can check it.`,
  code: r`~~~csharp
// SQL Server application lock scoped to a transaction: released on commit, rollback or connection death
await using var tx = await db.Database.BeginTransactionAsync(ct);
var result = await db.Database.SqlQuery<int>($"""
    DECLARE @r int;
    EXEC @r = sp_getapplock @Resource = {"eod-settlement:" + date}, @LockMode = 'Exclusive',
                            @LockOwner = 'Transaction', @LockTimeout = 0;
    SELECT @r AS Value
    """).SingleAsync(ct);
if (result < 0) return;                               // another pod holds it
await RunSettlementAsync(date, ct);                   // idempotent per (date, merchant)
await tx.CommitAsync(ct);

// Lease row with a fencing token
var claimed = await db.Leases
    .Where(l => l.Name == "fx-publisher" && (l.LeaseUntil < now || l.Owner == podId))
    .ExecuteUpdateAsync(s => s
        .SetProperty(l => l.Owner, podId)
        .SetProperty(l => l.LeaseUntil, now.AddSeconds(15))
        .SetProperty(l => l.FencingToken, l => l.FencingToken + 1), ct);
if (claimed == 1)
{
    var token = await db.Leases.Where(l => l.Name == "fx-publisher").Select(l => l.FencingToken).SingleAsync(ct);
    await publisher.PublishAsync(rates, fencingToken: token, ct);   // downstream rejects tokens older than the last seen
}

// Redis lock: release only if still ours (compare-and-delete in Lua)
const string ReleaseScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
~~~`,
  pts: [r`Prefer unique constraints, guarded updates, partitioning and schedulers over locks.`, r`sp_getapplock / advisory locks and lease rows use the database you already trust.`, r`Redis locks are fast but not safe against failover and pauses; Redlock is debated.`, r`Process pauses beyond lease expiry are unavoidable: use fencing tokens.`, r`Short leases with renewal; idempotent protected operations.`],
  ex: r`An end-of-day FX publisher used a Redis lock; during a 20-second GC pause on one pod the lock expired, a second pod published, and then the first pod woke and published stale rates over the new ones. A database lease with a fencing token, checked by the rate store, made stale publishes fail.`,
  fu: [r`Why can a lock service alone never guarantee mutual exclusion?`, r`How does sp_getapplock behave if the pod is killed?`, r`How would you elect a leader in Kubernetes without extra infrastructure?`],
  pit: [r`Distributed locks where a unique constraint would do.`, r`Releasing a Redis lock without checking ownership.`, r`Long leases with no renewal or fencing.`] },

{ id: 'q32', level: 'Senior', tags: ['aspnet-core', 'di', 'httpcontext', 'thread-safety'],
  q: r`Concurrency in ASP.NET Core applications: which objects are shared across requests, why is HttpContext not thread-safe, what goes wrong with IHttpContextAccessor and background work, and how do you review singletons for safety?`,
  a: r`### What is shared
- **Singleton** services, static fields, options snapshots ({{IOptionsMonitor}}), caches and HttpClient handlers: used by **every concurrent request**.
- **Scoped** services: one per request, used by one request at a time (as long as the request itself does not fan out concurrently).
- **Transient**: a new instance per resolution, but a transient captured by a singleton becomes effectively singleton.

### HttpContext
Not thread-safe and **only valid during the request**. After the response completes the object is reset and **reused for later requests** (pooled). Accessing it from a fire-and-forget task, a parallel branch, or after the request ended reads another request's data or throws.
- {{IHttpContextAccessor}} uses AsyncLocal: it returns the HttpContext of the current flow, which background work started from a request **still sees** after the request ended. Copy the values you need (user id, tenant, correlation id) into the work item instead.
- Do not read {{HttpContext.Request.Body}} or write the response from parallel tasks.

### Singleton review checklist
1. Mutable fields? → immutable, concurrent collections, or locks.
2. Captured scoped dependencies (DbContext, per-request services)? → captive dependency; inject {{IServiceScopeFactory}} or factories.
3. Non-thread-safe dependencies (Random, StringBuilder, a non-thread-safe SDK client)? → per-use instances or thread-safe alternatives.
4. Per-request state stored in fields ("current user")? → never; use scoped services or parameters.
5. Lazy initialisation races? → Lazy<T>.

### Background work from requests
Do not {{Task.Run}} work that uses scoped services after returning: the scope is disposed. Enqueue a message with copied values to a {{Channel}} drained by a {{BackgroundService}} that creates its own scope per item.

### Request fan-out
Parallel branches inside one request must not share the request's DbContext or other non-thread-safe scoped services.`,
  code: r`~~~csharp
// Bug: background work reads HttpContext after the request finished (pooled, reused object)
app.MapPost("/payments", (CreatePayment cmd, IHttpContextAccessor acc, IAuditService audit) =>
{
    _ = Task.Run(async () =>
    {
        await Task.Delay(100);
        await audit.WriteAsync(acc.HttpContext!.User.Identity!.Name!, cmd);   // wrong user or ObjectDisposedException
    });
    return Results.Accepted();
});

// Fixed: copy what you need, hand off to an owned queue, new scope per item
app.MapPost("/payments", async (CreatePayment cmd, HttpContext ctx, Channel<AuditItem> queue, CancellationToken ct) =>
{
    var item = new AuditItem(ctx.User.FindFirst("sub")!.Value, ctx.TraceIdentifier, cmd);
    await queue.Writer.WriteAsync(item, ct);
    return Results.Accepted();
});

public sealed class AuditWriter(Channel<AuditItem> queue, IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        await foreach (var item in queue.Reader.ReadAllAsync(stop))
        {
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IAuditService>().WriteAsync(item.UserId, item.Command);
        }
    }
}

// Singleton smell: per-request state in a field
public sealed class PricingService { public string? CurrentCurrency; /* shared by all requests: race */ }
~~~`,
  pts: [r`Singletons and statics are shared by all requests; review their state.`, r`HttpContext is per request, pooled and reused: never use it after the request.`, r`IHttpContextAccessor in background work returns stale or reused contexts: copy values.`, r`Background work goes through an owned queue with its own scope.`, r`Parallel branches must not share non-thread-safe scoped services.`],
  ex: r`An audit feature used IHttpContextAccessor inside a fire-and-forget task; under load some audit entries recorded a different user than the one who made the payment, which an internal auditor found during a SOX review. Copying the user id at request time and using a queued writer fixed it.`,
  fu: [r`Why is HttpContext pooled, and what does that imply?`, r`How does ValidateScopes help with captive dependencies?`, r`How would you build an analyzer that flags mutable fields in singletons?`],
  pit: [r`IHttpContextAccessor in background tasks.`, r`Per-request data in singleton fields.`, r`Task.Run using scoped services after the response.`] },

{ id: 'q33', level: 'Senior', tags: ['testing', 'concurrency-testing', 'coyote', 'stress'],
  q: r`How do you test concurrent code so that races and deadlocks are found before production? Cover deterministic interleaving, stress tests, systematic testing (Coyote), time abstraction and what to assert.`,
  a: r`### Why ordinary tests miss races
Races need a specific interleaving; a unit test runs one schedule, usually the lucky one. Passing tests prove little.

### Layers
1. **Design for testability**: inject {{TimeProvider}}, isolate the concurrency mechanism (a lane router, a single-flight helper) from business logic so it can be tested directly.
2. **Deterministic interleaving**: force the dangerous ordering with gates ({{TaskCompletionSource}}, {{Barrier}}, {{SemaphoreSlim}}) injected via test hooks: pause thread A after its read, let B complete, resume A, assert the outcome.
3. **Stress tests**: many threads, many iterations, randomised delays ({{Thread.Yield}}, {{Task.Yield}}, small random sleeps), run long in CI nightly; assert **invariants** (conservation of money, no duplicates, counters exact), not just "no exception".
4. **Systematic concurrency testing**: Microsoft **Coyote** controls the scheduler for async code and explores many interleavings deterministically, reproducing failures from a seed.
5. **Real infrastructure**: concurrency bugs at the database boundary (lost updates, deadlocks) need a real database (Testcontainers), with parallel sessions.
6. **Run on target hardware**: ARM64 runners for weak-memory issues; more cores than the developer laptop.

### What to assert
- Invariants: total balance unchanged by transfers; each idempotency key applied once; no item processed twice; ordering per key.
- Liveness: operations complete within a timeout (a hang is a failure, not a slow test).
- Absence of unobserved exceptions ({{UnobservedTaskException}} handler that fails the test).

### Production as a test environment
Chaos and fault injection (slow dependencies, pod kills) expose concurrency issues that only appear under real timing.`,
  code: r`~~~csharp
// Deterministic interleaving: force "both read before either writes"
[Fact]
public async Task Concurrent_debits_do_not_lose_updates()
{
    var bothRead = new Barrier(2);
    var store = new InMemoryAccountStore(balance: 100m) { AfterRead = () => bothRead.SignalAndWait(TimeSpan.FromSeconds(5)) };
    var svc = new DebitService(store);

    var results = await Task.WhenAll(Task.Run(() => svc.Debit(80m)), Task.Run(() => svc.Debit(80m)));

    Assert.Single(results, r => r == DebitResult.Ok);      // the buggy read-modify-write version fails here
    Assert.Equal(20m, store.Balance);
}

// Stress test asserting conservation of money
[Fact, Trait("Category", "Stress")]
public async Task Transfers_conserve_total_balance()
{
    var bank = new Bank(accounts: 50, initial: 1_000m);
    var tasks = Enumerable.Range(0, 64).Select(w => Task.Run(async () =>
    {
        var rnd = new Random(w);
        for (var i = 0; i < 10_000; i++)
        {
            await bank.TransferAsync(rnd.Next(50), rnd.Next(50), rnd.Next(1, 20));
            if (rnd.Next(100) == 0) await Task.Yield();
        }
    }));
    await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromMinutes(2));   // a hang fails the test
    Assert.Equal(50_000m, bank.TotalBalance());
}

// Coyote: explore interleavings systematically (run via the Coyote test engine)
[Fact]
public void Coyote_explores_schedules()
{
    var config = Configuration.Create().WithTestingIterations(1_000);
    var engine = TestingEngine.Create(config, async () =>
    {
        var cache = new SingleFlight<string, int>();
        var calls = 0;
        var t1 = cache.GetAsync("k", async _ => { Interlocked.Increment(ref calls); await Task.Yield(); return 1; });
        var t2 = cache.GetAsync("k", async _ => { Interlocked.Increment(ref calls); await Task.Yield(); return 1; });
        await Task.WhenAll(t1, t2);
        Specification.Assert(calls <= 2, "unexpected extra loads");
    });
    engine.Run();
    Assert.Equal(0, engine.TestReport.NumOfFoundBugs);
}
~~~`,
  pts: [r`Single runs prove little: races need specific interleavings.`, r`Force interleavings with injected gates; stress with randomised yields.`, r`Assert invariants and liveness, not just absence of exceptions.`, r`Coyote explores async schedules systematically and reproduces from seeds.`, r`Real databases and target hardware (ARM64) for boundary and memory-model bugs.`],
  ex: r`A conservation-of-money stress test, run nightly with 64 workers, caught a lost-update race introduced by a refactor that moved a balance read outside a lock; the PR's unit tests had all passed. The failing seed reproduced locally within minutes.`,
  fu: [r`How do you make a flaky concurrency test reproducible?`, r`What does Coyote control that a normal test runner does not?`, r`How long should stress tests run, and where?`],
  pit: [r`Thread.Sleep-based "synchronisation" in tests.`, r`Asserting only that no exception was thrown.`, r`Testing database concurrency with in-memory fakes.`] },

{ id: 'q34', level: 'Senior', tags: ['async-performance', 'valuetask', 'allocations', 'state-machine'],
  q: r`Where does async code spend CPU and memory (state machines, Task allocations, continuations, ExecutionContext), and when do ValueTask, cached tasks, synchronous fast paths and eliding async actually help?`,
  a: r`### Costs of an async method
- A **state machine** struct, boxed to the heap on the **first await that does not complete synchronously**.
- A **Task** (or Task<T>) object for the result, unless cached ({{Task.CompletedTask}}, cached {{Task<bool>}}, small ints).
- **Continuation** registration and scheduling to the pool; **ExecutionContext** capture and restore.
Each is small (tens to a few hundred bytes, sub-microsecond), but in a method called millions of times per second they add up.

### Optimisations, by usefulness
1. **Avoid unnecessary async layers**: a method that only returns another call's task can return it directly (elide async/await), but only when no {{using}}, try/catch, or code after the call is needed, because eliding changes exception and disposal timing.
2. **Synchronous fast path**: if the result is often available immediately (cache hit, buffered data), return it without awaiting.
3. **ValueTask<T>**: avoids the Task allocation when the result is **usually synchronous**. Rules: await it **once**, never concurrently, never {{.Result}} before completion; convert with {{AsTask()}} if you need to store or await it multiple times.
4. **Pooled async state machines**: {{[AsyncMethodBuilder(typeof(PoolingAsyncValueTaskMethodBuilder<>))]}} on hot ValueTask methods (.NET 6+), measured first.
5. **IValueTaskSource** pooling for infrastructure (sockets, channels).

### What does not help
- ConfigureAwait(false) in ASP.NET Core app code (no context to avoid).
- Making CPU-bound work "async" with Task.Run.
- ValueTask everywhere: it is a larger struct, easier to misuse, and gives nothing when calls usually complete asynchronously (real I/O).

### Measure
BenchmarkDotNet with {{[MemoryDiagnoser]}}; production allocation profiling (dotnet-trace gc-verbose, dotnet-counters allocation rate).`,
  code: r`~~~csharp
// Synchronous fast path with ValueTask: cache hits allocate nothing
public ValueTask<Rate> GetRateAsync(string pair, CancellationToken ct)
{
    if (_cache.TryGetValue(pair, out var rate)) return ValueTask.FromResult(rate);   // common case: no Task allocation
    return new ValueTask<Rate>(LoadAndCacheAsync(pair, ct));                           // rare case: real async
}

// Eliding async is safe here (pure pass-through)...
public Task<Account> GetAsync(Guid id, CancellationToken ct) => _repo.GetAsync(id, ct);

// ...but NOT here: the using would dispose the connection before the query completes
public Task<int> CountBad(CancellationToken ct) { using var c = Open(); return c.CountAsync(ct); }
public async Task<int> CountGood(CancellationToken ct) { using var c = Open(); return await c.CountAsync(ct); }

// ValueTask misuse
var vt = GetRateAsync("EURUSD", ct);
var a = await vt;
// var b = await vt;     // undefined behaviour with pooled sources: never await twice
var task = GetRateAsync("GBPUSD", ct).AsTask();      // convert if you must store or await multiple times

// Pooled builder for a measured hot path (.NET 6+)
[AsyncMethodBuilder(typeof(PoolingAsyncValueTaskMethodBuilder<>))]
private async ValueTask<int> ReadFrameAsync(CancellationToken ct) { /* ... */ return await _pipe.ReadAsync(ct); }
~~~`,
  pts: [r`Costs: boxed state machine on first real await, Task objects, continuations, ExecutionContext.`, r`Elide pass-through async only when no using, try or code after the call.`, r`Synchronous fast paths and ValueTask help when results are usually synchronous.`, r`ValueTask rules: await once, never concurrently, AsTask to store.`, r`Pooling builders and IValueTaskSource only for measured hot paths.`],
  ex: r`A FX-rate lookup called 2 million times per second allocated a Task<Rate> per call although 99% were cache hits; switching to ValueTask with a synchronous fast path cut allocations by 180 MB/s and gen0 GCs by 85%. The same change applied to a database repository gave no measurable benefit and was reverted.`,
  fu: [r`Why does the state machine get boxed only on the first incomplete await?`, r`What exception-timing difference does eliding async introduce?`, r`When is Task.FromResult cached by the runtime?`],
  pit: [r`ValueTask everywhere.`, r`Awaiting a ValueTask twice.`, r`Eliding async around using blocks.`] },

{ id: 'q35', level: 'Senior', tags: ['spinning', 'spinlock', 'spinwait', 'latency'],
  q: r`Spinning vs blocking: when does SpinWait or SpinLock beat a lock, what do Thread.Yield, Sleep(0) and Sleep(1) actually do, and what are the risks (priority inversion, wasted CPU, containers with CPU limits)?`,
  a: r`### The trade-off
Blocking puts the thread to sleep in the kernel: cheap in CPU, but **waking takes microseconds** (a context switch and scheduler latency). Spinning keeps the thread running and checking: **nanosecond** reaction, but burns a core while waiting.
Spinning wins only when the expected wait is **shorter than a context switch** and **another core** is actually running the thread that will release the resource.

### .NET tools
- {{SpinWait}}: a struct that spins with increasing back-off and eventually yields ({{SpinOnce}}); {{SpinWait.SpinUntil(condition, timeout)}}. Used internally by ManualResetEventSlim, SemaphoreSlim and Monitor before blocking.
- {{SpinLock}}: a non-reentrant spinning lock (a struct: never copy it, never store it in a readonly field). For extremely short critical sections with low contention. Rarely beats {{lock}}, which already spins adaptively.
- {{Thread.Yield()}}: give up the rest of the time slice to another ready thread **on the same core**.
- {{Thread.Sleep(0)}}: yield to any ready thread of equal or higher priority.
- {{Thread.Sleep(1)}}: actually sleep for at least a timer tick (often 1 to 15 ms): a huge delay in low-latency code.

### Risks
- **Single core or CPU-limited containers**: spinning waits for a thread that cannot run because you are using the core. Pure waste; Kubernetes CPU throttling (CFS quota) makes it worse by pausing the whole process mid-spin.
- **Priority inversion**: a high-priority spinner prevents a low-priority holder from running.
- **Power and noisy-neighbour effects** on shared hosts.

### Where spinning belongs
Ultra-low-latency systems on **dedicated, pinned cores** (market data handlers, matching engines with busy-spin consumers like the LMAX Disruptor), not general web services.`,
  code: r`~~~csharp
// Busy-spin consumer for a dedicated core (low-latency feed handler)
public void Run(CancellationToken stop)
{
    var spinner = new SpinWait();
    while (!stop.IsCancellationRequested)
    {
        if (_ring.TryRead(out var msg)) { Handle(msg); spinner.Reset(); continue; }
        spinner.SpinOnce(sleep1Threshold: -1);          // spin and yield, never Sleep(1)
    }
}

// SpinWait.SpinUntil for a very short expected wait, with a timeout fallback
if (!SpinWait.SpinUntil(() => Volatile.Read(ref _published) == seq, TimeSpan.FromMicroseconds(50)))
    _signal.Wait(stop);                                  // fall back to blocking

// SpinLock: struct, never readonly, never copied
private SpinLock _spin = new(enableThreadOwnerTracking: false);
public void Add(long v)
{
    bool taken = false;
    try { _spin.Enter(ref taken); _total += v; }
    finally { if (taken) _spin.Exit(useMemoryBarrier: false); }
}
// For general code, lock (or System.Threading.Lock) already spins adaptively and is the better default.
~~~`,
  pts: [r`Spin only when waits are shorter than a context switch and the holder is running on another core.`, r`SpinWait backs off and yields; lock already spins adaptively before blocking.`, r`SpinLock is a struct: never readonly, never copied; rarely better than lock.`, r`Sleep(1) sleeps a timer tick; Yield and Sleep(0) only yield.`, r`Never spin in CPU-limited containers; spinning belongs on dedicated pinned cores.`],
  ex: r`A team copied a busy-spin consumer from a trading system into a Kubernetes service with a 1-CPU limit; CFS throttling paused the pod for 80 ms of every 100 ms period and latency was worse than with a blocking queue. Replacing it with a Channel reader cut p99 from 120 ms to 3 ms.`,
  fu: [r`What happens if you store a SpinLock in a readonly field?`, r`How does CPU throttling in Kubernetes interact with spinning?`, r`What is the LMAX Disruptor's wait-strategy choice?`],
  pit: [r`SpinLock as a general-purpose lock.`, r`Busy-spinning in shared or CPU-limited environments.`, r`Thread.Sleep(1) in latency-sensitive loops.`] },

{ id: 'q36', level: 'Senior', tags: ['gc', 'server-gc', 'containers', 'latency'],
  q: r`How do the garbage collector and threading interact: GC suspension, workstation vs server GC, background GC, DATAS, allocation contexts, and what container CPU and memory limits do to both?`,
  a: r`### Suspension
A blocking GC **suspends all managed threads** at safe points while it marks or compacts (background GC does most gen2 marking concurrently, but gen0/gen1 collections and phases of gen2 still pause). Pause time adds directly to tail latency of every in-flight request. Threads in long tight loops without safe points (rare since return-address hijacking and GC polls) can delay suspension.

### GC flavours
| Mode | Heaps | Good for |
|---|---|---|
| **Workstation** (concurrent) | one heap, GC on the triggering thread | desktop apps, small containers |
| **Server** | one heap and one GC thread **per core** | throughput services; larger memory footprint |
| **DATAS** (.NET 8 opt-in, default on in .NET 9 with Server GC) | dynamically adapts heap count to load | containers and bursty services: lower memory than classic server GC |
| **Background GC** | concurrent gen2 marking | default; reduces gen2 pauses |

### Allocation contexts
Each thread allocates from its own **allocation context** (a slice of gen0) without locking; high allocation rates mean frequent gen0 GCs, each pausing all threads.

### Containers
- {{Environment.ProcessorCount}} follows the **CPU limit** (rounded up): it sizes the thread pool minimum, server GC heap count, and Parallel defaults. A limit of 0.5 CPU means 1.
- GC heap limit defaults to **75% of the container memory limit**; set {{GCHeapHardLimit}} or {{GCHeapHardLimitPercent}} deliberately if other memory (native buffers) matters.
- Server GC in many small pods wastes memory; DATAS or workstation GC is often better below 2 CPUs.
- CPU throttling (CFS quota) during GC stretches pauses: a GC using several threads on a 1-CPU quota gets throttled.

### Reducing GC impact on latency
Allocate less on hot paths (pooling, spans, avoiding LINQ in tight loops); avoid the **Large Object Heap** churn (objects of 85 KB or more); {{GCSettings.LatencyMode = SustainedLowLatency}} during critical windows; measure with dotnet-counters (GC pause time ratio, gen0/1/2 counts, allocation rate).`,
  code: r`~~~xml
<!-- Service.csproj: explicit GC configuration for a 2-CPU pod -->
<PropertyGroup>
  <ServerGarbageCollection>true</ServerGarbageCollection>
  <ConcurrentGarbageCollection>true</ConcurrentGarbageCollection>
  <GarbageCollectionAdaptationMode>1</GarbageCollectionAdaptationMode>   <!-- DATAS (default on .NET 9 with server GC) -->
</PropertyGroup>
~~~
~~~csharp
// Observe GC from inside the service
var info = GC.GetGCMemoryInfo();
Console.WriteLine($"cpu={Environment.ProcessorCount} heapLimit={info.TotalAvailableMemoryBytes / 1_048_576} MB " +
                  $"pause%={GC.GetTotalPauseDuration().TotalMilliseconds / Environment.TickCount64 * 100:F2}");

// Critical trading window: discourage blocking gen2 GCs
var old = GCSettings.LatencyMode;
GCSettings.LatencyMode = GCLatencyMode.SustainedLowLatency;
try { await RunAuctionAsync(ct); } finally { GCSettings.LatencyMode = old; }
~~~
~~~bash
dotnet-counters monitor -n Pricing --counters System.Runtime[gc-heap-size,time-in-gc,gen-0-gc-count,gen-2-gc-count,alloc-rate,loh-size]
~~~`,
  pts: [r`Blocking GCs suspend all managed threads: pauses add to every request's latency.`, r`Workstation vs Server vs DATAS: pick by cores, memory and burstiness.`, r`ProcessorCount follows the container CPU limit; heap limit defaults to 75% of memory limit.`, r`CPU throttling stretches GC pauses in small pods.`, r`Reduce allocation rate and LOH churn; measure pause ratio and allocation rate.`],
  ex: r`A pricing service ran Server GC in 40 pods with 1-CPU limits and 2 GB memory; heaps sized for many cores pushed pods into OOM kills under bursts. Switching to DATAS halved memory use and removed the kills, and a hot-path allocation fix cut gen0 GCs from 40/s to 6/s, improving p99 by 9 ms.`,
  fu: [r`What is a safe point, and how does the runtime reach one?`, r`When would you choose workstation GC for a server app?`, r`How does SustainedLowLatency differ from NoGCRegion?`],
  pit: [r`Server GC defaults in tiny pods without measuring.`, r`Ignoring CPU limits when sizing parallelism.`, r`Large object allocations per request.`] },

{ id: 'q37', level: 'Principal', tags: ['single-writer', 'matching-engine', 'disruptor', 'low-latency'],
  q: r`Design the concurrency model of an in-memory order-matching engine (100,000 orders per second, microsecond latency, deterministic replay). Why do such systems use the single-writer principle instead of locks?`,
  a: r`### Single-writer principle
Each piece of mutable state (an order book per instrument) is owned and mutated by **exactly one thread**. No locks, no CAS on the book, no cache-line ping-pong: the owning thread works on data hot in its own cache. Other threads communicate with it only through queues.

### Architecture (LMAX style)
1. **Input**: gateways receive orders, validate statelessly in parallel, and publish to a **ring buffer** (pre-allocated array, sequence numbers, no allocation per message).
2. **Journaling and replication** consumers persist the input sequence **before or in parallel with** processing.
3. **Business logic thread**: a single thread per shard (instrument or instrument group) consumes events in sequence and matches: deterministic, so the same input sequence always yields the same output.
4. **Output** ring buffer: executions and market data to publishers.

### Why it is fast
- No contention, no locks, no context switches on the hot path (busy-spin consumers on **pinned, isolated cores**).
- Mechanical sympathy: sequential memory access, pre-allocated structures, padded sequence counters (no false sharing), zero GC on the hot path.
- Batching naturally under load: a consumer that falls behind processes all available events at once.

### Resilience and scale
- **Deterministic replay** of the journal rebuilds state after a crash or on a hot standby that consumes the same input stream.
- Scale by **sharding** instruments across engine threads or processes; cross-instrument operations (spreads) need coordination or a dedicated shard.
- Snapshots periodically to bound replay time.

### In .NET
Achievable: struct-based ring buffers (Disruptor-net), {{GC.TryStartNoGCRegion}} or allocation-free hot paths, Server GC with SustainedLowLatency, thread pinning via OS affinity, and careful avoidance of LINQ, closures, async on the hot path. The business logic thread is plain synchronous code.`,
  dia: r`flowchart LR
  G1[Gateway 1] --> RB[(Input ring buffer, sequenced)]
  G2[Gateway 2] --> RB
  RB --> J[Journaler]
  RB --> REP[Replicator to standby]
  RB --> BL[Single business-logic thread per shard: order books]
  BL --> OUT[(Output ring buffer)]
  OUT --> MD[Market data publisher]
  OUT --> EX[Execution reports]`,
  code: r`~~~csharp
// Single-threaded book: no locks because only the engine thread touches it
public sealed class OrderBook
{
    private readonly SortedDictionary<long, Queue<Order>> _bids = new(Comparer<long>.Create((a, b) => b.CompareTo(a)));
    private readonly SortedDictionary<long, Queue<Order>> _asks = new();
    public void Apply(in OrderEvent e, IExecutionSink sink) { /* match, emit fills: deterministic */ }
}

// Engine loop on a dedicated, pinned thread consuming a sequenced ring buffer
public sealed class MatchingEngine(RingBuffer<OrderEvent> input, OrderBook[] books, IExecutionSink sink)
{
    public void Run(CancellationToken stop)
    {
        long next = 0; var spin = new SpinWait();
        while (!stop.IsCancellationRequested)
        {
            var available = input.PublishedSequence;            // volatile read
            if (available < next) { spin.SpinOnce(-1); continue; }
            for (; next <= available; next++)                   // natural batching when behind
            {
                ref readonly var e = ref input[next];
                books[e.InstrumentIndex].Apply(in e, sink);
            }
            input.ConsumerSequence = available;                 // volatile write frees slots for producers
            spin.Reset();
        }
    }
}

var engineThread = new Thread(() => engine.Run(stop)) { IsBackground = false, Priority = ThreadPriority.Highest, Name = "engine-0" };
engineThread.Start();                                           // pin via OS affinity (taskset / processor affinity) on an isolated core
~~~`,
  pts: [r`One thread owns each piece of mutable state: no locks, no contention.`, r`Sequenced ring buffers in, journal and replicate, single logic thread, ring buffer out.`, r`Determinism enables replay, hot standbys and testing.`, r`Mechanical sympathy: pinned cores, busy-spin, pre-allocation, no GC on hot path.`, r`Scale by sharding instruments; cross-shard operations need coordination.`],
  ex: r`A crypto exchange's first matching engine locked each order book and topped out at 15,000 orders/s with 5 ms p99 under bursts; the single-writer redesign on pinned cores reached 400,000 orders/s with 40 µs p99, and deterministic replay let a standby take over in under a second.`,
  fu: [r`How do you handle an order that spans two shards (a spread)?`, r`How large should the ring buffer be, and what happens when it is full?`, r`How do you upgrade engine code without losing determinism with the journal?`],
  pit: [r`Locks around a shared book accessed by many threads.`, r`Allocations and async on the matching hot path.`, r`Non-deterministic logic (time, random) inside the engine without recording it as input.`] },

{ id: 'q38', level: 'Principal', tags: ['payments', 'system-design', 'concurrency-model', 'idempotency'],
  q: r`Design the concurrency model of a payment-processing service handling 5,000 payments per second across 12 pods: per-account ordering, exactly-once effects, contention on hot merchant accounts, and where locks live (memory vs database).`,
  a: r`### Principles
1. **No correctness-critical state in process memory**: pods are disposable; correctness lives in the database and the log.
2. **Single owner per key** for ordering, provided by partitioning (Kafka partitions keyed by account), not by distributed locks.
3. **Idempotency at every boundary**.
4. **Contention managed by design**, not by retries.

### Flow
- API: validate, write the payment intent + outbox row with an **idempotency key** (unique index) in one transaction; return 202.
- Relay publishes {{PaymentRequested}} keyed by **payer account**.
- Processor pods: Kafka assigns partitions; inside each pod, events are routed to **lanes by account hash** (sequential per account, parallel across accounts).
- Each step: debit via a **guarded atomic UPDATE** (balance check in the WHERE clause), ledger entries append-only, outbox events for the next step. Offsets committed only for contiguous completed events.
- Gateway/scheme calls carry the idempotency key; responses recorded; retries reuse the key.

### Hot merchant accounts
A merchant receiving 1,000 credits/s: one row at 2 ms lock hold time caps at 500 updates/s. Options: **append-only ledger entries without updating a balance row** on each credit (balance computed or snapshotted periodically), **sharded balance rows**, or batching credits per merchant every 100 ms in the merchant's lane.

### Where locks live
- **Database row locks** for the instant of a guarded update (short, last in the transaction, canonical order for multi-account operations).
- **In-memory** only for caches and non-critical coordination (single-flight, per-lane queues).
- **No distributed locks** on the payment path.

### Failure handling
Pod crash: uncommitted offsets are redelivered, idempotency makes reprocessing harmless. Rebalance: drain lanes for revoked partitions. Database failover: retries with idempotency keys. Poison events: park per account to a retry topic; block or flag that account's subsequent events depending on the business rule.`,
  dia: r`flowchart LR
  API[API pods] -->|txn: intent + outbox, idempotency key| DB[(SQL)]
  DB --> RL[Outbox relay]
  RL --> K[(Kafka: payments keyed by account)]
  K --> P1[Processor pod: lanes by account hash]
  K --> P2[Processor pod: lanes by account hash]
  P1 -->|guarded UPDATE + ledger + outbox| DB
  P2 -->|guarded UPDATE + ledger + outbox| DB
  P1 -->|idempotency key| GW[Scheme gateway]`,
  code: r`~~~csharp
// Inside a lane: sequential per account, idempotent, short transaction, guarded debit last
async Task HandleAsync(PaymentRequested e, CancellationToken ct)
{
    await using var db = await factory.CreateDbContextAsync(ct);
    var strategy = db.Database.CreateExecutionStrategy();
    await strategy.ExecuteAsync(async () =>
    {
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (await db.ProcessedEvents.AnyAsync(p => p.EventId == e.EventId, ct)) return;          // idempotent
        db.ProcessedEvents.Add(new ProcessedEvent(e.EventId));
        db.Ledger.Add(LedgerEntry.Debit(e.PayerAccountId, e.Amount, e.PaymentId));
        db.Outbox.Add(OutboxMessage.From(new PaymentDebited(e.PaymentId)));
        await db.SaveChangesAsync(ct);

        var ok = await db.Accounts.Where(a => a.Id == e.PayerAccountId && a.Available >= e.Amount)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Available, a => a.Available - e.Amount), ct);
        if (ok == 0) { await tx.RollbackAsync(ct); await RejectAsync(e, "insufficient funds", ct); return; }
        await tx.CommitAsync(ct);
    });
}

// Hot merchant credits: append ledger entries only; a per-merchant lane folds them into the balance every 100 ms
~~~`,
  pts: [r`Correctness in the database and log; pods are disposable.`, r`Ordering per account from Kafka keys plus in-pod lanes, not distributed locks.`, r`Idempotency keys at API, processing and gateway boundaries.`, r`Guarded atomic updates with short row locks; append-only ledgers for hot accounts.`, r`Redelivery plus idempotency handles crashes and rebalances.`],
  ex: r`A PSP's first design held a Redis lock per account around each payment; during a Redis failover locks were lost and 0.02% of payments double-debited. The redesign used Kafka ordering, guarded database updates and idempotency keys, and removed the lock service from the payment path entirely.`,
  fu: [r`How do you handle a payment involving two accounts in different partitions?`, r`What happens to in-flight lane work during a Kafka rebalance?`, r`How do you prove exactly-once effects in production?`],
  pit: [r`Distributed locks on the payment hot path.`, r`Correctness depending on in-memory state.`, r`Retrying hot-row conflicts instead of redesigning.`] },

{ id: 'q39', level: 'Principal', tags: ['architecture', 'concurrency-models', 'decision-framework'],
  q: r`Give a decision framework for choosing a concurrency model for a new .NET service: shared state with locks, async I/O with stateless handlers, partitioned single-threaded workers, actors, dataflow pipelines, or pushing concurrency into the database.`,
  a: r`### Start from the questions
1. **Where is the state?** No shared mutable state in the process is the easiest model to get right.
2. **What is the work?** I/O-bound (most services) vs CPU-bound (pricing, risk, compression).
3. **What ordering is required?** None, per key, or total.
4. **What latency target?** Milliseconds (normal) vs microseconds (trading).
5. **Who will maintain it?** Team skills and operational maturity matter more than theoretical elegance.

### Models
| Model | Fits | Costs |
|---|---|---|
| **Stateless async handlers, state in the database** | most APIs and CRUD-heavy services | database becomes the concurrency arbiter; needs good transactions and idempotency |
| **Shared state + locks** | small in-memory caches, counters, coordinators | contention, deadlock risk, hard reviews; keep it tiny |
| **Immutable snapshots** | read-mostly reference data | rebuild cost on change |
| **Partitioned single-threaded workers** | per-key ordering, stateful stream processing | hot-key skew, rebalancing logic |
| **Actors (Orleans/Akka)** | many hot independent entities, low-latency stateful logic | new runtime to operate, cross-entity transactions via sagas |
| **Dataflow / channels pipelines** | multi-stage throughput processing with backpressure | durability must come from the source |
| **Single-writer ring buffers** | microsecond, deterministic systems | specialised skills, dedicated hardware |
| **Database concurrency** (guarded updates, isolation, constraints) | correctness-critical invariants across pods | throughput limits on hot rows |

### My default
Stateless async handlers; correctness via the database (constraints, guarded updates, idempotency); partitioned workers where ordering matters; immutable snapshots for reference data; locks only for small, well-encapsulated in-process structures. Escalate to actors or single-writer designs only with measured needs.

### Guardrails whatever the model
Bounded queues, timeouts, cancellation, idempotency, observability of queue depth and lock contention, and tests that assert invariants under concurrency.`,
  code: r`~~~csharp
// The default: stateless handler, correctness pushed to the database
app.MapPost("/limits/{accountId}/reserve", async (Guid accountId, ReserveRequest r, LimitsDb db, CancellationToken ct) =>
{
    var ok = await db.Limits.Where(l => l.AccountId == accountId && l.Used + r.Amount <= l.Max)
        .ExecuteUpdateAsync(s => s.SetProperty(l => l.Used, l => l.Used + r.Amount), ct);
    return ok == 1 ? Results.Ok() : Results.Conflict("Limit exceeded");
});

// Escalation 1: per-key ordering -> partitioned lanes
var processor = new PartitionedProcessor(lanes: 32, HandleAsync, stop);

// Escalation 2: hot stateful entities with low latency -> actors
var wallet = grains.GetGrain<IWalletGrain>(walletId);

// Small in-process shared state -> encapsulated lock, nothing escapes the class
public sealed class RollingWindow { private readonly Lock _g = new(); private readonly Queue<long> _q = new(); /* ... */ }
~~~`,
  pts: [r`Decide by state location, work type, ordering, latency and team skills.`, r`Default: stateless async handlers with database-enforced correctness.`, r`Partitioned workers for per-key order; snapshots for read-mostly data.`, r`Actors and single-writer designs only for measured needs.`, r`Bounded queues, timeouts, idempotency and invariant tests everywhere.`],
  ex: r`A team proposed Orleans for a merchant-onboarding service with 200 requests per minute; the framework review steered them to stateless handlers on SQL, delivered in four weeks. The same review approved Orleans for a wallet service with 30,000 balance operations per second, where it removed hot-row contention.`,
  fu: [r`How do you migrate between models later without a rewrite?`, r`What signals tell you a lock-based design has outgrown itself?`, r`How do team skills change your recommendation?`],
  pit: [r`Choosing the most sophisticated model by default.`, r`Correctness in memory for multi-pod services.`, r`Ignoring operational cost of new runtimes.`] },

{ id: 'q40', level: 'Principal', tags: ['async-migration', 'legacy', 'sync-over-async', 'strategy'],
  q: r`A 600,000-line .NET codebase is mostly synchronous, with sync-over-async in places and recurring thread-pool starvation. Plan the migration to async across many teams without a big-bang rewrite.`,
  a: r`### Why it is hard
Async is **viral**: making a low-level method async forces every caller up the stack to change. Doing it halfway creates **sync-over-async** (blocking on async) and **async-over-sync** (Task.Run around blocking calls), both worse than either pure form.

### Strategy
1. **Measure and target**: find where threads block (dumps grouped by stack, dotnet-counters during load tests with injected latency). Usually a handful of I/O seams (HTTP clients, database access, cache, message clients) cause most blocking.
2. **Bottom-up on hot paths**: convert the I/O seams to async first, then propagate upward along the hottest request paths, not file by file.
3. **Temporary dual APIs**: keep the sync method alongside {{XAsync}} during transition (implemented separately against sync and async I/O, never one wrapping the other), mark the sync one {{[Obsolete]}} with a removal date.
4. **Entry points**: ASP.NET Core controllers and handlers become async; background services use async loops.
5. **Ban new debt**: analyzers as errors on new code ({{VSTHRD002}}, {{CA1849}}, {{VSTHRD103}}); baseline existing violations and burn them down per team.
6. **Isolate what cannot move**: a legacy sync SDK runs on a dedicated bounded worker (thread or LongRunning task fed by a channel) so it cannot starve the pool.
7. **Cancellation along the way**: add CancellationToken parameters while touching signatures, once.

### Organisation
- A platform team owns the shared I/O libraries and converts them first.
- Each team gets a **dashboard**: analyzer violation counts, blocking stacks from production profiling, starvation incidents.
- Stopgap during the migration: {{SetMinThreads}} tuned per service, documented with an expiry.

### Done means
No blocking waits on hot paths, starvation alerts silent under latency-injection load tests, analyzer baseline at zero.`,
  code: r`~~~csharp
// Transitional dual API: separate implementations, sync marked for removal
public interface IAccountClient
{
    [Obsolete("Use GetAsync. Sync API removed in 2027.Q2 (ticket PLAT-412).")]
    Account Get(Guid id);
    Task<Account> GetAsync(Guid id, CancellationToken ct);
}

// Isolating an unmovable sync SDK: dedicated worker, bounded queue, async facade
public sealed class LegacyFxGateway : IAsyncDisposable
{
    private readonly Channel<(FxRequest Req, TaskCompletionSource<FxQuote> Tcs)> _q =
        Channel.CreateBounded<(FxRequest, TaskCompletionSource<FxQuote>)>(256);
    private readonly Task _worker;
    public LegacyFxGateway(LegacyFxSdk sdk) =>
        _worker = Task.Factory.StartNew(() =>
        {
            foreach (var (req, tcs) in _q.Reader.ReadAllAsync().ToBlockingEnumerable())
                try { tcs.TrySetResult(sdk.Quote(req)); } catch (Exception ex) { tcs.TrySetException(ex); }
        }, TaskCreationOptions.LongRunning);

    public async Task<FxQuote> QuoteAsync(FxRequest r, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<FxQuote>(TaskCreationOptions.RunContinuationsAsynchronously);
        await _q.Writer.WriteAsync((r, tcs), ct);
        return await tcs.Task.WaitAsync(ct);
    }
    public async ValueTask DisposeAsync() { _q.Writer.Complete(); await _worker; }
}
~~~
~~~ini
# .editorconfig: no new blocking debt
dotnet_diagnostic.VSTHRD002.severity = error   # synchronous waits
dotnet_diagnostic.VSTHRD103.severity = error   # call async methods when in async method
dotnet_diagnostic.CA1849.severity    = error
~~~`,
  pts: [r`Async is viral; half-migrations create sync-over-async and async-over-sync.`, r`Measure blocking stacks; convert I/O seams bottom-up along hot paths.`, r`Transitional dual APIs with separate implementations and removal dates.`, r`Analyzers as errors for new code, baselines burned down per team.`, r`Isolate unmovable sync SDKs on dedicated bounded workers.`],
  ex: r`An insurer's claims platform had monthly starvation incidents; profiling showed 80% of blocking in four libraries (HTTP, SQL, Redis, document storage). Converting those and their 60 hottest call paths over two quarters ended the incidents, while the long tail of sync code was migrated opportunistically over the following year.`,
  fu: [r`Why is wrapping sync I/O in Task.Run not a real migration?`, r`How do you prioritise which call paths to convert first?`, r`How do you keep teams from adding new .Result calls?`],
  pit: [r`Big-bang rewrites.`, r`Sync methods implemented as GetAwaiter().GetResult() of async ones.`, r`Task.Run wrappers presented as async.`] },

{ id: 'q41', level: 'Principal', tags: ['incident', 'race-condition', 'data-corruption', 'postmortem'],
  q: r`Incident: under peak load, about 1 in 50,000 payment confirmations shows another customer's masked card number. No errors are logged. Lead the investigation, the fix, and the prevention plan.`,
  a: r`### Treat it as a security incident first
Cross-customer data exposure: contain (feature flag the affected screen or field), notify security and privacy, preserve evidence (logs, dumps), estimate exposure from logs.

### Hypotheses for "rare, load-dependent, no errors"
Classic signature of a **race on shared mutable state**:
- A **singleton** with a mutable field used per request (a formatter, a "current card" field, a reused buffer or StringBuilder).
- A non-thread-safe object shared (a pooled object returned to a pool while still in use; an {{ArrayPool}} buffer used after return).
- **Thread-static** or {{IHttpContextAccessor}} used from background work.
- A **cache keyed incorrectly** (missing tenant or customer id in the key), or a cache entry mutated after insertion.
- Object pooling of DTOs reused across requests.

### Investigation
1. Correlate affected requests: same pod? same time windows as GC or high concurrency? same code path (recently changed?).
2. Code search for shared state on the confirmation path: singletons' fields, statics, pools, caches, thread-locals.
3. Reproduce with a **stress test**: many concurrent confirmations with distinct cards; assert each response's card matches its request.
4. Enable targeted logging: log the object identity hash of suspected shared instances per request.

### Typical root cause and fix
A singleton {{ReceiptFormatter}} cached the last card's masked number in a field between two steps. Fix: make the formatter stateless (pass values through parameters) or scoped; return pooled buffers only after the last use.

### Prevention
- Review rule and analyzer: **no mutable instance fields in singletons** without explicit thread-safety comments.
- Stress tests on money and PII paths asserting request/response correspondence.
- Ownership rules for pooled objects (no use after return; {{ArrayPool}} buffers cleared when they held sensitive data).
- A response-integrity check in critical flows: verify the confirmation belongs to the authenticated customer before sending.`,
  code: r`~~~csharp
// Root cause: singleton with per-request state in a field
public sealed class ReceiptFormatter                         // registered as singleton
{
    private string? _maskedPan;                              // shared by all requests
    public void Prepare(Payment p) => _maskedPan = Mask(p.CardToken);
    public Receipt Build(Payment p) => new(p.Id, _maskedPan!, p.Amount);   // another request may have overwritten it
}

// Fix: stateless, data flows through parameters
public sealed class SafeReceiptFormatter
{
    public Receipt Build(Payment p) => new(p.Id, Mask(p.CardToken), p.Amount);
}

// Reproduction / regression stress test: every response must match its request
[Fact, Trait("Category", "Stress")]
public async Task Receipts_never_cross_customers()
{
    var formatter = new SafeReceiptFormatter();
    var payments = Enumerable.Range(0, 100_000).Select(i => TestPayments.WithCard($"tok_{i}")).ToArray();
    await Parallel.ForEachAsync(payments, new ParallelOptions { MaxDegreeOfParallelism = 64 }, (p, _) =>
    {
        var r = formatter.Build(p);
        Assert.Equal(Mask(p.CardToken), r.MaskedPan);
        return ValueTask.CompletedTask;
    });
}

// Defence in depth before sending
if (receipt.CustomerId != user.CustomerId) throw new SecurityException("Response integrity check failed");
~~~`,
  pts: [r`Rare, load-dependent, error-free cross-user data = race on shared state.`, r`Contain and treat as a security incident before debugging.`, r`Suspects: singleton fields, statics, pools used after return, bad cache keys, thread-locals.`, r`Reproduce with a stress test asserting request/response correspondence.`, r`Prevent with singleton review rules, ownership rules for pools, integrity checks.`],
  ex: r`This pattern was found at a card issuer: 23 customers saw another customer's masked PAN over two weeks. The postmortem added an analyzer for mutable singleton fields, which flagged 41 more singletons across the estate; three had real races.`,
  fu: [r`How would you estimate the number of affected customers from logs?`, r`What ArrayPool usage rules prevent use-after-return?`, r`What would an analyzer for mutable singleton fields check?`],
  pit: [r`Debugging quietly before containing a data exposure.`, r`Fixing one class without searching for the pattern.`, r`Unit tests as proof of thread safety.`] },

{ id: 'q42', level: 'Principal', tags: ['capacity-planning', 'littles-law', 'queueing', 'adaptive-concurrency'],
  q: r`Use Little's Law and basic queueing theory to set concurrency limits, thread-pool expectations and queue sizes for a service, and explain why utilisation near 100% destroys latency.`,
  a: r`### Little's Law
**L = λ × W**: average items in the system = arrival rate × average time in the system. It holds for any stable system.
- 2,000 requests/s at 50 ms average → **100 requests in flight** on average across the fleet.
- Each in-flight request may hold a DB connection for part of its time: 2,000/s × 10 ms DB time → **20 connections busy** on average.

### Utilisation and queueing
For a single server with random arrivals (M/M/1), mean time in system W = S / (1 − ρ), where S is service time and ρ utilisation.
| ρ | W relative to S |
|---|---|
| 50% | 2× |
| 80% | 5× |
| 90% | 10× |
| 95% | 20× |
Tail latency grows even faster. Running a dependency (a database, a hot row, a lock) at 90%+ means latency explodes on any burst.

### Applying it
- **Concurrency limit per dependency** = (capacity rate × latency) with headroom, divided by replicas. Beyond it, queue briefly then shed (429/503).
- **Queue size**: a queue only helps absorb bursts shorter than (queue length / service rate). Queue length × service time = added latency: a 1,000-item queue in front of a 100/s consumer adds **10 seconds**. Size queues from the latency budget, not from memory.
- **Thread pool**: for async I/O, threads ≈ cores is enough; if the formula says you need hundreds of threads, something is blocking.
- **Hot rows / locks**: max throughput = 1 / hold time; plan utilisation below about 70%.

### Adaptive concurrency
Capacity changes (failovers, noisy neighbours). **AIMD** or gradient limiters (as in Netflix's concurrency-limits) increase the limit while latency is stable and cut it when latency rises, finding the knee automatically. .NET's RateLimiting library provides the primitives; the adaptive policy is yours.`,
  code: r`~~~csharp
// Derive limits from measured rates rather than guessing
public static class Capacity
{
    public static int InFlight(double ratePerSec, TimeSpan latency) => (int)Math.Ceiling(ratePerSec * latency.TotalSeconds);
    public static TimeSpan QueueDelay(int queueLength, double serviceRatePerSec) => TimeSpan.FromSeconds(queueLength / serviceRatePerSec);
    public static double MeanWaitFactor(double utilisation) => 1 / (1 - utilisation);   // M/M/1
}
var partnerLimitPerPod = Capacity.InFlight(ratePerSec: 300, latency: TimeSpan.FromMilliseconds(80)) / replicas;   // 24 / 12 = 2

// Simple AIMD limiter: +1 when healthy, halve on latency breach
public sealed class AimdLimit(int min, int max, TimeSpan target)
{
    private int _limit = min;
    public int Current => Volatile.Read(ref _limit);
    public void OnSample(TimeSpan latency)
    {
        int cur, next;
        do { cur = _limit; next = latency > target ? Math.Max(min, cur / 2) : Math.Min(max, cur + 1); }
        while (Interlocked.CompareExchange(ref _limit, next, cur) != cur);
    }
}
~~~`,
  pts: [r`L = λW turns rates and latencies into in-flight counts.`, r`Latency grows as 1 / (1 − ρ): avoid running dependencies above ~70–80%.`, r`Concurrency limits from capacity × latency, divided by replicas.`, r`Queue length × service time = added latency: size queues from the latency budget.`, r`Adaptive (AIMD) limits find the knee when capacity varies.`],
  ex: r`A reconciliation service had a 50,000-item in-memory queue in front of a database writer doing 500 writes/s: during bursts, items waited 100 seconds and upstream timeouts caused retries that deepened the queue. A 500-item queue with load shedding and an AIMD writer concurrency kept latency under 2 seconds.`,
  fu: [r`Why does tail latency grow faster than mean latency near saturation?`, r`How would you measure service time vs queueing time in production?`, r`What does the formula say about adding pods when the database is at 90%?`],
  pit: [r`Large queues as a "buffer".`, r`Sizing limits from defaults.`, r`Running shared dependencies near 100% utilisation.`] },

{ id: 'q43', level: 'Principal', tags: ['backpressure', 'load-shedding', 'resilience', 'end-to-end'],
  q: r`Design end-to-end backpressure for an ingestion platform (HTTP ingress → in-process queues → Kafka → consumers → database) so that overload anywhere degrades gracefully instead of cascading.`,
  a: r`### The rule
**Every queue is bounded, and every boundary has a policy for "full"**: wait briefly, shed, or degrade. Unbounded anything converts overload into memory exhaustion and latency explosions.

### Layer by layer
1. **Edge / gateway**: per-client rate limits and a global concurrency limit; reject with **429 / 503 + Retry-After** quickly. Clients must back off with jitter.
2. **Service ingress**: Kestrel limits (max concurrent connections, request body size), a ConcurrencyLimiter on expensive endpoints, request deadlines.
3. **In-process queues**: bounded Channels; when full, the endpoint returns 503 rather than awaiting forever (short wait timeout).
4. **Kafka producer**: bounded buffer ({{queue.buffering.max.kbytes}}, {{message.timeout.ms}}); if Kafka is unavailable, fail the request or spill to a durable local outbox, never grow memory.
5. **Consumers**: pull-based, so backpressure is natural: process at the database's pace; **pause partitions** when the internal queue is full; consumer lag is the visible buffer (and the alert).
6. **Database**: connection pool caps, short timeouts, guarded writes; batch inserts to raise throughput.

### Degradation before failure
Shed low-priority work first (analytics events before payments), serve stale cached data, disable expensive features via flags.

### Avoid retry amplification
Retries multiply load at the worst time: **retry budgets** (for example at most 10% extra), exponential backoff with jitter, retry at one layer only, and circuit breakers on dependencies.

### Observability
Queue depths, rejection counts by reason, consumer lag, pool waits, and latency per layer: you should see *where* pressure accumulates.`,
  dia: r`flowchart LR
  C[Clients with backoff] --> GW[Gateway: rate limits, 429]
  GW --> API[API: concurrency limiter, deadlines, 503 when queue full]
  API --> Q[Bounded channel]
  Q --> PR[Kafka producer: bounded buffer]
  PR --> K[(Kafka: lag is the buffer)]
  K --> CO[Consumer: pause partitions when full]
  CO --> DB[(Database: pool caps, batching)]`,
  code: r`~~~csharp
// API: short wait on a bounded channel, then shed
app.MapPost("/events", async (IngestEvent e, Channel<IngestEvent> q, CancellationToken ct) =>
{
    using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
    wait.CancelAfter(TimeSpan.FromMilliseconds(50));
    try { await q.Writer.WriteAsync(e, wait.Token); return Results.Accepted(); }
    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
    {
        return Results.Problem(statusCode: 503, title: "Overloaded", extensions: new Dictionary<string, object?> { ["retryAfter"] = 2 });
    }
});

// Consumer: pause Kafka partitions when the internal queue is full, resume when drained
while (!stop.IsCancellationRequested)
{
    if (internalQueue.Reader.Count > HighWatermark && !paused) { consumer.Pause(consumer.Assignment); paused = true; }
    if (internalQueue.Reader.Count < LowWatermark && paused) { consumer.Resume(consumer.Assignment); paused = false; }
    var cr = consumer.Consume(TimeSpan.FromMilliseconds(100));
    if (cr is not null) await internalQueue.Writer.WriteAsync(cr, stop);
}

// Retry budget: allow retries only while they stay under 10% of requests
if (!retryBudget.TryWithdraw()) throw new RetryBudgetExhaustedException();
~~~`,
  pts: [r`Bound every queue; define the policy when full.`, r`Shed early at the edge with 429/503 and Retry-After.`, r`Consumers pull at the database's pace and pause partitions; lag is the buffer.`, r`Degrade low-priority work first.`, r`Retry budgets, backoff with jitter, retries at one layer only.`],
  ex: r`During a merchant's flash sale, an event-ingestion API with unbounded buffers ran out of memory on every pod within four minutes, and client retries kept it down for 40 minutes. With bounded channels, 503s with Retry-After and paused consumers, the next sale peaked at three times the load with 4% of requests shed and no outage.`,
  fu: [r`Where would you put priority-based shedding?`, r`How do client SDKs need to behave for this to work?`, r`How do you test backpressure behaviour before peak events?`],
  pit: [r`Unbounded buffers anywhere in the chain.`, r`Retries at every layer.`, r`Accepting work you cannot finish within its deadline.`] },

{ id: 'q44', level: 'Principal', tags: ['lock-free', 'design-review', 'risk', 'linearizability'],
  q: r`A senior engineer proposes replacing the locks in the risk-limit service with a custom lock-free data structure "for performance". How do you evaluate the proposal?`,
  a: r`### Start with evidence, not technique
1. **Is the lock the bottleneck?** Contention counters, ContentionStart traces, profiler lock-wait time under production-like load. If the lock costs 2% of latency, stop here.
2. **Cheaper alternatives first**: shrink the critical section, remove I/O from it, shard by key, immutable snapshots, single-writer queue. These usually deliver most of the gain with ordinary code.
3. **Existing proven structures**: ConcurrentDictionary, Channels, ImmutableInterlocked, FrozenDictionary are lock-free or low-lock and maintained by the runtime team.

### If a custom lock-free structure is still justified
- **Correctness argument**: what is the **linearisation point** of each operation? Which invariants hold across CAS retries? How is ABA handled? What memory-ordering guarantees are relied on, and are they valid on **ARM64**?
- **Progress guarantees**: lock-free (someone always progresses) vs wait-free; behaviour under heavy contention (CAS retry storms can be slower than a lock).
- **Testing plan**: systematic concurrency testing (Coyote), long stress tests on x64 and ARM64, invariant assertions, model checking for the core algorithm if feasible.
- **Benchmarks**: BenchmarkDotNet under realistic contention (thread counts, read/write mix), including tail latency, compared against the best lock-based alternative, not the current naive one.
- **Maintainability**: who else can review and debug it? Documented invariants, a small encapsulated surface, a kill switch (feature flag back to the lock version).

### Decision
Approve only if: measured contention matters, cheaper alternatives were tried, the design has a written correctness argument, the tests explore interleavings on target hardware, and at least two engineers can own it. For a **risk-limit service**, a correctness bug is a regulatory incident; the bar is high.`,
  code: r`~~~csharp
// The usually-better alternative: shard the lock by desk, no custom algorithm
public sealed class ShardedLimits
{
    private readonly (Lock Gate, Dictionary<string, decimal> Used)[] _shards =
        Enumerable.Range(0, 64).Select(_ => (new Lock(), new Dictionary<string, decimal>())).ToArray();

    public bool TryReserve(string desk, decimal amount, decimal limit)
    {
        var s = _shards[(int)((uint)desk.GetHashCode() % 64)];
        lock (s.Gate)
        {
            var used = s.Used.GetValueOrDefault(desk);
            if (used + amount > limit) return false;
            s.Used[desk] = used + amount;
            return true;
        }
    }
}

// Benchmark the real alternatives under contention before deciding
[MemoryDiagnoser, ThreadingDiagnoser]
public class LimitBench
{
    [Params(4, 16, 64)] public int Threads;
    [Benchmark(Baseline = true)] public void SingleLock()   => RunParallel(Threads, _single.TryReserve);
    [Benchmark]                  public void Sharded()      => RunParallel(Threads, _sharded.TryReserve);
    [Benchmark]                  public void LockFreeProto() => RunParallel(Threads, _proposal.TryReserve);
}
~~~`,
  pts: [r`Prove the lock is the bottleneck before changing it.`, r`Try shrinking, sharding, snapshots and single-writer queues first.`, r`Require a written correctness argument: linearisation points, ABA, memory ordering on ARM64.`, r`Systematic and stress testing on target hardware; benchmarks against the best alternative.`, r`Ownership, documentation and a kill switch; a high bar for regulated services.`],
  ex: r`A proposed lock-free limit tracker benchmarked 3× faster than the existing single lock but only 8% faster than a 64-way sharded lock; Coyote found a lost-update bug in the prototype within an hour. The team shipped the sharded version.`,
  fu: [r`What is a linearisation point?`, r`Why can lock-free code be slower than locks under contention?`, r`What evidence would make you approve the proposal?`],
  pit: [r`Comparing against a naive baseline.`, r`No correctness argument or systematic tests.`, r`Single-owner custom concurrency code.`] },

{ id: 'q45', level: 'Principal', tags: ['code-review', 'concurrency-bugs', 'csharp'],
  q: r`Code review: find the concurrency bugs in this service and explain the fixes.`,
  a: r`~~~csharp
public class QuoteService                          // registered as singleton
{
    private readonly Dictionary<string, Quote> _cache = new();
    private readonly HttpClient _http;
    private static Random _rnd = new Random();
    private int _requests;
    private DateTime _lastRefresh;

    public Quote Get(string symbol)
    {
        _requests++;
        if (!_cache.ContainsKey(symbol) || DateTime.Now - _lastRefresh > TimeSpan.FromSeconds(5))
        {
            lock (this)
            {
                var q = _http.GetFromJsonAsync<Quote>("/q/" + symbol).Result;
                _cache[symbol] = q!;
                _lastRefresh = DateTime.Now;
            }
        }
        Thread.Sleep(_rnd.Next(0, 3));             // "jitter"
        return _cache[symbol];
    }

    public async void RefreshAll()
    {
        foreach (var s in _cache.Keys) await RefreshAsync(s);
    }
}
~~~

Findings, most severe first:
1. **Unsynchronised Dictionary** in a singleton: reads ({{ContainsKey}}, indexer) outside the lock race with writes inside it; corruption, exceptions, or an **infinite loop**. Use ConcurrentDictionary or an immutable snapshot.
2. **Sync-over-async under a lock**: {{.Result}} blocks a pool thread for the HTTP call **while holding the lock**, serialising all symbols behind one slow call: thread-pool starvation plus a convoy. Make it async; never do I/O inside a lock.
3. **lock (this)**: external code can lock the same object. Use a private lock (and for async, SemaphoreSlim or per-key single-flight).
4. **Check-then-act race / stampede**: many threads see a stale entry and all queue to refresh. Single-flight per key.
5. **One global _lastRefresh for all symbols**: refreshing one symbol marks every symbol fresh; staleness is per entry. Store a timestamp per entry.
6. **_requests++** is a lost-update race: use Interlocked or a metrics Counter.
7. **Shared static Random** is not thread-safe: use {{Random.Shared}}. And **Thread.Sleep** in a request path wastes a pool thread: remove it.
8. **async void RefreshAll**: exceptions crash the process; also **enumerates _cache.Keys** while other threads modify the Dictionary (InvalidOperationException or corruption). Return Task, enumerate a snapshot.
9. **DateTime.Now**: local time and not testable; use {{TimeProvider}} and UTC.
10. Missing CancellationToken and timeout on the HTTP call; string concatenation in the URL without encoding.`,
  code: r`~~~csharp
public sealed class QuoteService(HttpClient http, TimeProvider clock, ILogger<QuoteService> log)   // singleton, now thread-safe
{
    private sealed record Entry(Quote Quote, DateTimeOffset FetchedAt);
    private readonly ConcurrentDictionary<string, Entry> _cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<Entry>>> _inflight = new(StringComparer.Ordinal);
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(5);
    private static readonly Counter<long> Requests = new Meter("Quotes").CreateCounter<long>("quote_requests");

    public async ValueTask<Quote> GetAsync(string symbol, CancellationToken ct)
    {
        Requests.Add(1);
        if (_cache.TryGetValue(symbol, out var e) && clock.GetUtcNow() - e.FetchedAt < Ttl) return e.Quote;
        var lazy = _inflight.GetOrAdd(symbol, s => new Lazy<Task<Entry>>(() => FetchAsync(s)));     // single-flight
        try { return (await lazy.Value.WaitAsync(ct)).Quote; }
        finally { _inflight.TryRemove(new(symbol, lazy)); }
    }

    private async Task<Entry> FetchAsync(string symbol)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var q = await http.GetFromJsonAsync<Quote>($"/q/{Uri.EscapeDataString(symbol)}", cts.Token)
                ?? throw new InvalidOperationException($"No quote for {symbol}");
        var entry = new Entry(q, clock.GetUtcNow());
        _cache[symbol] = entry;
        return entry;
    }

    public async Task RefreshAllAsync(CancellationToken ct)
    {
        foreach (var symbol in _cache.Keys.ToArray())                                // snapshot
            try { await GetAsync(symbol, ct); } catch (Exception ex) { log.LogWarning(ex, "Refresh {Symbol} failed", symbol); }
    }
}
~~~`,
  pts: [r`Shared Dictionary read outside the lock: corruption and infinite loops.`, r`.Result under a lock: starvation and a convoy; never I/O inside locks.`, r`lock(this), shared Random, ++ on a field, Thread.Sleep in request paths.`, r`Per-entry staleness and single-flight refresh instead of a global timestamp.`, r`async void and enumerating a mutating collection; TimeProvider, UTC, timeouts.`],
  ex: r`A near-identical quote cache in a retail FX app caused a weekly incident: one slow upstream call held the lock, 300 requests queued behind it, the pool starved, and health checks failed, restarting pods that then stampeded the upstream. The rewrite above removed the lock entirely.`,
  fu: [r`Which of these bugs would tests most likely miss, and why?`, r`How would you roll out the fix safely?`, r`What metrics would you add to see the stampede before it hurts?`],
  pit: [r`Fixing only the Dictionary and leaving I/O under the lock.`, r`Replacing .Result with GetAwaiter().GetResult().`, r`Keeping a single global refresh timestamp.`] },

{ id: 'q46', level: 'Principal', tags: ['standards', 'analyzers', 'governance', 'training'],
  q: r`You own concurrency quality for 25 .NET teams. What standards, analyzers, libraries, review practices and training do you put in place, and how do you measure that it is working?`,
  a: r`### Encode rules in tools, not wiki pages
**Analyzers as build errors** (with baselines for legacy code):
- {{Microsoft.VisualStudio.Threading.Analyzers}}: VSTHRD002 (no synchronous waits), VSTHRD100 (no async void), VSTHRD103 (call async methods in async code), VSTHRD110 (observe results of async calls), VSTHRD111 (ConfigureAwait in libraries).
- .NET analyzers: CA1849, CA2007 (libraries), CA2012 (ValueTask misuse), CA2016 (forward CancellationToken), CA1001 / IDisposable rules.
- Custom Roslyn rules: no mutable instance fields in classes registered as singletons without an attribute declaring the thread-safety strategy; no {{lock (this)}} or lock on strings/types; no {{Parallel.ForEach}} with async lambdas; no DbContext injected into singletons.

### Paved-road libraries
Shared, tested building blocks so teams do not hand-roll them: single-flight cache, keyed async lock, partitioned lane processor, bounded background queue with draining, rate limiting handlers, retry budgets, TimeProvider everywhere.

### Review practice
A concurrency checklist on PRs touching shared state: what is shared, who mutates it, what guarantees order, what happens on cancellation, failure and shutdown, where are the bounds. Designated reviewers for changes to the paved-road libraries.

### Testing standards
Stress tests with invariant assertions for money and PII paths; deterministic interleaving tests for custom coordination code; Coyote for complex async coordination; load tests with injected dependency latency (exposes blocking).

### Runtime safety nets
Dashboards and alerts per service: thread-pool queue length, lock contention rate, GC pause ratio, unobserved task exceptions, queue depths. Dumps on hang (automatic dump collection on liveness failure).

### Training
A short course built from **our own incidents** (starvation, singleton races, stampedes, deadlocks) with the fixes; reviewers trained on the checklist.

### Measuring success
Concurrency-related incidents per quarter, mean time to diagnose hangs, analyzer baseline burn-down, adoption of paved-road components, starvation alerts under load tests.`,
  code: r`~~~ini
# Directory.Build.props + .editorconfig shared by all repos
[*.cs]
dotnet_diagnostic.VSTHRD002.severity = error    # sync waits on async
dotnet_diagnostic.VSTHRD100.severity = error    # async void
dotnet_diagnostic.VSTHRD103.severity = error
dotnet_diagnostic.VSTHRD110.severity = error    # unobserved async call
dotnet_diagnostic.CA2012.severity    = error    # ValueTask misuse
dotnet_diagnostic.CA2016.severity    = warning  # forward CancellationToken
dotnet_diagnostic.PLAT001.severity   = error    # custom: mutable field in singleton
~~~
~~~csharp
// Custom analyzer contract: singletons must declare their thread-safety strategy
[AttributeUsage(AttributeTargets.Class)]
public sealed class ThreadSafetyAttribute(ThreadSafetyStrategy strategy, string justification) : Attribute;
public enum ThreadSafetyStrategy { Immutable, ConcurrentCollections, Locked, SingleWriter }

[ThreadSafety(ThreadSafetyStrategy.Immutable, "Rates published as FrozenDictionary snapshots")]
public sealed class FxRateCache { /* ... */ }
~~~`,
  pts: [r`Analyzers as errors with baselines: VSTHRD, CA rules and custom singleton rules.`, r`Paved-road concurrency components instead of hand-rolled ones.`, r`Review checklist: what is shared, ordering, cancellation, failure, bounds.`, r`Stress, interleaving and latency-injection tests for critical paths.`, r`Measure incidents, diagnosis time, baseline burn-down and adoption.`],
  ex: r`After three starvation incidents and one singleton data leak in a year, a bank's platform group rolled out analyzers with baselines, a shared single-flight cache and lane processor, and an incident-based training. Concurrency incidents dropped from 11 to 2 the following year, and both were diagnosed within an hour thanks to automatic hang dumps.`,
  fu: [r`How do you introduce analyzers as errors into repos with thousands of violations?`, r`Which paved-road component would you build first and why?`, r`How do you keep the checklist from becoming box-ticking?`],
  pit: [r`Guidelines without enforcement.`, r`Each team hand-rolling caches and locks.`, r`Training from generic examples instead of your own incidents.`] },

{ id: 'q47', level: 'Principal', tags: ['graceful-shutdown', 'durability', 'kubernetes', 'background-work'],
  q: r`Pods are killed during deployments and scale-in. How do you make in-process concurrent work (background queues, in-flight requests, consumers) survive shutdown without losing or duplicating effects?`,
  a: r`### What happens on termination (Kubernetes)
1. The pod is marked terminating and removed from Service endpoints (asynchronously: traffic may still arrive for a few seconds).
2. {{preStop}} hook runs, then **SIGTERM** is sent.
3. .NET's host triggers {{ApplicationStopping}}, calls {{StopAsync}} on hosted services (in reverse order), within {{HostOptions.ShutdownTimeout}} (default 30 s in recent versions).
4. After {{terminationGracePeriodSeconds}} (default 30 s), **SIGKILL**: anything unfinished is lost.

### Principles
- **In-memory queues are not durable.** Anything that must happen must be recorded durably **before** acknowledging (database row, outbox, Kafka offset not yet committed). The in-memory queue is only a performance buffer.
- **Stop intake first, then drain, with a deadline**: stop accepting new HTTP requests (readiness fails), stop polling or pause consumers, complete channel writers, let workers finish in-flight items, then cancel.
- **Commit progress only after effects**: Kafka offsets after processing, outbox rows marked after publish; on kill, redelivery plus idempotency make reprocessing safe.
- **Budget the timeline**: preStop sleep (5 s for endpoint propagation) + drain (≤ 20 s) < grace period, with ShutdownTimeout aligned.

### Specifics
- Kestrel finishes in-flight requests during shutdown; long requests (exports, streaming) need their own cancellation.
- {{BackgroundService}}: ExecuteAsync receives the stopping token; override StopAsync for draining logic; do not block StopAsync beyond the budget.
- Fire-and-forget tasks are invisible to the host: route them through an owned queue that drains in StopAsync, or they die mid-flight.
- Long jobs: checkpoint progress so a restart resumes rather than restarts.`,
  code: r`~~~csharp
builder.Services.Configure<HostOptions>(o =>
{
    o.ShutdownTimeout = TimeSpan.FromSeconds(25);
    o.ServicesStopConcurrently = true;                 // .NET 8: stop hosted services in parallel
});

public sealed class LedgerPostingWorker(Channel<PostingCommand> queue, IServiceScopeFactory scopes,
                                        ILogger<LedgerPostingWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        // Items are already durable (outbox rows); the channel is only a buffer
        await foreach (var cmd in queue.Reader.ReadAllAsync(CancellationToken.None))   // drain even after stopping
        {
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IPoster>().PostAsync(cmd, CancellationToken.None);  // idempotent
        }
    }

    public override async Task StopAsync(CancellationToken deadline)
    {
        queue.Writer.TryComplete();                                  // stop intake
        log.LogInformation("Draining {Count} postings", queue.Reader.Count);
        await Task.WhenAny(ExecuteTask ?? Task.CompletedTask, Task.Delay(Timeout.Infinite, deadline));
        await base.StopAsync(deadline);                              // remaining items are re-read from the outbox on next start
    }
}
~~~
~~~yaml
# Pod spec: give the app time to drain
spec:
  terminationGracePeriodSeconds: 40
  containers:
    - name: payments
      lifecycle:
        preStop:
          exec: { command: ["sleep", "5"] }    # let endpoint removal propagate before SIGTERM
      readinessProbe: { httpGet: { path: /health/ready, port: 8080 }, periodSeconds: 2 }
~~~`,
  pts: [r`SIGTERM, then the grace period, then SIGKILL: budget the timeline.`, r`In-memory queues are buffers; durability comes from the database, outbox or log.`, r`Stop intake, drain with a deadline, then cancel.`, r`Commit offsets and mark done only after effects; idempotency covers redelivery.`, r`Fire-and-forget work dies at shutdown: route it through owned, draining queues.`],
  ex: r`Each deployment of a notifications service silently dropped a few hundred messages held in an in-memory channel; customers missed payment confirmations. Persisting the outbox before enqueueing, draining in StopAsync, and a 40-second grace period ended the losses, verified by comparing outbox counts with sent counts per deploy.`,
  fu: [r`Why can traffic still arrive after SIGTERM?`, r`How do you handle a job that takes 10 minutes?`, r`How do you verify no messages are lost during deployments?`],
  pit: [r`Treating in-memory queues as durable.`, r`Default grace periods shorter than the drain.`, r`Committing offsets before processing.`] },

{ id: 'q48', level: 'Principal', tags: ['caching', 'consistency', 'race-conditions', 'invalidation'],
  q: r`Concurrency between an in-memory/distributed cache and the database: describe the classic invalidation races (stale set after update, read-through overwrite), and design a cache strategy for account limits that stays correct under concurrency.`,
  a: r`### Classic races
1. **Read-through overwrite**: request A misses, reads the DB (old value); B updates the DB and invalidates the cache; A then **writes its old value** into the cache. The cache is stale until TTL expiry.
2. **Update then set race**: two writers update the DB in order 1, 2 but set the cache in order 2, 1: the cache holds version 1.
3. **Stampede** on expiry: many concurrent loads (covered by single-flight).
4. **Multi-pod in-memory caches**: an invalidation reaches some pods late or never (missed pub/sub message), each pod has a different view.
5. **Cache and DB transaction mismatch**: the cache is updated, then the DB transaction rolls back.

### Fixes
- **Version every value** (rowversion or a sequence) and only set the cache if the new version is **greater** than the cached one (compare-and-set: Redis Lua script or a conditional update in memory).
- **Invalidate after commit** (outbox event or CDC), never before or inside the transaction.
- Short TTLs as a safety net, not as the correctness mechanism.
- For pod-local caches: invalidation via pub/sub **plus** versions and TTL, so a missed message heals.
- **Decide what must never be stale**: for an account **limit check**, the authoritative check is the guarded database update; the cache only accelerates *rejecting* clearly over-limit requests or showing limits in the UI.

### Account limits design
- Read path: cached limit configuration (versioned, short TTL) used for fast pre-checks and display.
- Write path for usage: atomic guarded update in the database (the source of truth); the cache never holds usage counters that decide money movement unless the cache is the system of record with atomic operations (Redis INCRBY with a Lua limit check) and durability is acceptable.
- Limit changes publish an event after commit; pods update their cache if the event's version is newer.`,
  code: r`~~~csharp
public sealed record CachedLimit(decimal Max, long Version);

public sealed class LimitCache(IConnectionMultiplexer redis)
{
    // Set only if newer: prevents an old read-through value overwriting a newer one
    private const string SetIfNewer = """
        local cur = redis.call('HGET', KEYS[1], 'v')
        if (not cur) or (tonumber(cur) < tonumber(ARGV[2])) then
          redis.call('HSET', KEYS[1], 'max', ARGV[1], 'v', ARGV[2])
          redis.call('PEXPIRE', KEYS[1], ARGV[3])
          return 1
        end
        return 0
        """;

    public Task SetAsync(string accountId, CachedLimit l) =>
        redis.GetDatabase().ScriptEvaluateAsync(SetIfNewer, [(RedisKey)$"limit:{accountId}"],
            [l.Max.ToString(CultureInfo.InvariantCulture), l.Version, 60_000]);
}

// Invalidate/refresh after commit via the outbox, never inside the transaction
db.Outbox.Add(OutboxMessage.From(new LimitChanged(accountId, newMax, version)));
await db.SaveChangesAsync(ct);   // relay publishes; subscribers call SetAsync with the event's version

// Authoritative check stays in the database
var reserved = await db.Limits.Where(l => l.AccountId == id && l.Used + amount <= l.Max)
    .ExecuteUpdateAsync(s => s.SetProperty(l => l.Used, l => l.Used + amount), ct);
~~~`,
  pts: [r`Read-through overwrite and out-of-order sets leave stale values.`, r`Version values and set only if newer.`, r`Invalidate after commit via outbox or CDC; TTL is a safety net.`, r`Pod-local caches need pub/sub plus versions plus TTL.`, r`Money decisions use the authoritative store; caches accelerate reads.`],
  ex: r`A card platform cached spending limits in Redis with read-through loading; after a customer raised their limit, an in-flight read-through wrote the old limit back and purchases were declined for the 10-minute TTL, generating support calls. Versioned compare-and-set writes and post-commit invalidation fixed it.`,
  fu: [r`How would you cache a value that is updated 1,000 times a second?`, r`What consistency does HybridCache give across pods?`, r`When is the cache allowed to be the system of record?`],
  pit: [r`Invalidating before the transaction commits.`, r`Unversioned cache sets.`, r`Money decisions made from cached counters.`] },

{ id: 'q49', level: 'Principal', tags: ['tail-latency', 'low-latency', 'gc', 'trading'],
  q: r`A trading API meets its median latency (300 µs) but p99.9 is 40 ms. Identify the concurrency- and runtime-related sources of tail latency in .NET and the engineering plan to bring p99.9 under 2 ms.`,
  a: r`### Sources of tail latency
| Source | Mechanism |
|---|---|
| **GC pauses** | gen0/gen1 and blocking gen2 suspend all threads; LOH allocations trigger gen2 |
| **Thread-pool queueing** | a burst of work queues behind busy workers; continuation scheduling delays |
| **Lock convoys** | a holder is descheduled while holding a lock; waiters pile up |
| **Context switches / scheduler** | OS scheduling latency, CPU frequency scaling, noisy neighbours, CFS throttling in containers |
| **JIT and tiering** | first calls and tier-up after deploy; OSR transitions |
| **Kernel/network** | Nagle, interrupt coalescing, socket buffer sizes |
| **Logging and telemetry** | synchronous sinks, contention in exporters |

### Plan
1. **Measure properly**: HDR histograms per stage (receive, parse, decide, send), coordinated-omission-aware load generation, correlate spikes with GC events ({{GC.GetTotalPauseDuration}}, EventPipe), thread-pool queue length and CPU throttling metrics.
2. **Allocation diet** on the hot path: structs, spans, pooled buffers, no LINQ or closures, no boxing, pre-sized collections; target near-zero allocations per message so gen0 GCs become rare. Avoid LOH.
3. **GC configuration**: Server GC (or workstation non-concurrent for a single-core pinned process), {{SustainedLowLatency}} during market hours, consider {{GC.TryStartNoGCRegion}} for bounded critical windows; large enough gen0 budget ({{GCgen0size}}) to reduce GC frequency.
4. **Threading model**: dedicated threads on **isolated, pinned cores** for the hot path, single-writer state, busy-spin or SpinWait consumers; keep the thread pool for non-critical work.
5. **No locks on the hot path**; if unavoidable, very short and uncontended.
6. **Warm-up**: ReadyToRun or tiered PGO with explicit warm-up traffic before taking load; consider {{TieredCompilation}} settings for predictability.
7. **Infrastructure**: dedicated hosts (not shared Kubernetes nodes with CPU limits), CPU governor set to performance, NIC tuning, TCP_NODELAY.
8. **Telemetry off the hot path**: lock-free ring buffers to a background exporter; sampled logging.`,
  code: r`~~~csharp
// Hot-path message handling without allocations
public void OnMessage(ReadOnlySpan<byte> frame)
{
    if (!Parser.TryParse(frame, out OrderMsg msg)) { _rejects++; return; }   // struct parse, no strings
    var decision = _risk.Check(in msg);                                         // single-writer state, no locks
    _encoder.WriteAck(in msg, decision, _sendBuffer.Span);                      // pre-allocated buffer
    _socket.Send(_sendBuffer.Span[.._encoder.Length]);
}

// Bounded no-GC window around an auction cross (fails if the budget is too small)
if (GC.TryStartNoGCRegion(totalSize: 200 * 1024 * 1024))
{
    try { RunAuctionCross(); }
    finally { if (GCSettings.LatencyMode == GCLatencyMode.NoGCRegion) GC.EndNoGCRegion(); }
}

// Latency histogram per stage (HdrHistogram-style), recorded without allocation
_parseLatency.RecordValue(Stopwatch.GetElapsedTime(start).Ticks);
~~~
~~~xml
<PropertyGroup>
  <ServerGarbageCollection>true</ServerGarbageCollection>
  <ConcurrentGarbageCollection>false</ConcurrentGarbageCollection>
  <TieredPGO>true</TieredPGO>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
~~~`,
  pts: [r`Tail latency comes from GC, pool queueing, convoys, scheduling, JIT and telemetry.`, r`Measure per stage with HDR histograms and correlate with GC and throttling.`, r`Near-zero allocations on the hot path; GC modes and no-GC regions for critical windows.`, r`Dedicated pinned threads, single-writer state, no locks on the hot path.`, r`Warm-up, dedicated hosts, and telemetry moved off the hot path.`],
  ex: r`An FX streaming API had 300 µs median and 35 ms p99.9; histograms showed spikes aligned with gen1 GCs triggered by 2 MB/s of allocations from logging and LINQ. An allocation diet, pinned hot-path threads and asynchronous telemetry brought p99.9 to 1.4 ms on the same hardware.`,
  fu: [r`What is coordinated omission and why does it hide tail latency?`, r`When does NoGCRegion fail?`, r`Why are Kubernetes CPU limits bad for latency-critical services?`],
  pit: [r`Reporting averages for latency-critical systems.`, r`Shared, CPU-limited nodes for trading hot paths.`, r`Synchronous logging on the hot path.`] },

{ id: 'q50', level: 'Principal', tags: ['stateful-services', 'sharding', 'consistent-hashing', 'ownership'],
  q: r`An in-memory, stateful risk aggregator works on one big VM with locks. It must now run on 10 pods. How do you move from in-process concurrency to distributed ownership: sharding, single owner per key, rebalancing and failover?`,
  a: r`### What changes
In one process, locks give mutual exclusion and memory gives one consistent view. Across pods, neither exists: you need **ownership** (exactly one pod is responsible for a key at a time), **routing** (requests and events for a key reach its owner), and **recovery** (state rebuilt when ownership moves).

### Ownership options
| Mechanism | How ownership is assigned |
|---|---|
| **Kafka partitions** | consumer group assigns partitions; key → partition → owner pod |
| **Actor runtime** (Orleans) | runtime places grains and routes calls |
| **Consistent hashing** with membership (Kubernetes endpoints, a coordination service) | key → hash ring → pod; minimal movement when pods change |
| **Lease table** per shard in a database | pods claim shard leases; fencing tokens on writes |

For an event-driven aggregator, **Kafka partition ownership** is usually the simplest: state per partition, rebuilt from a compacted changelog topic or snapshots.

### Rebalancing and failover
- On revocation: stop processing the shard, **flush state and commit offsets**, then release.
- On assignment: **restore state** (snapshot + replay from the changelog or offsets) before processing; requests for the shard during restore wait or are rejected.
- Expect duplicates across handovers: idempotent updates and fencing tokens on external writes.
- Avoid stop-the-world rebalances: cooperative/incremental rebalancing; static membership for rolling restarts.

### Queries across shards
Aggregations across all keys become **scatter-gather** (fan out to all owners, merge) or are served from a separate read model fed by every shard's output.

### Inside each pod
Keep the in-process model simple: per-partition single-threaded processing (no locks), bounded queues, snapshots for fast recovery.`,
  dia: r`flowchart LR
  E[(Trades topic keyed by book)] --> P0[Pod A owns partitions 0-3]
  E --> P1[Pod B owns partitions 4-7]
  E --> P2[Pod C owns partitions 8-11]
  P0 --> CL[(Changelog topic, compacted)]
  P1 --> CL
  P2 --> CL
  CL -.->|restore on reassignment| P1
  P0 --> RM[(Read model for cross-book queries)]
  P1 --> RM
  P2 --> RM`,
  code: r`~~~csharp
var consumer = new ConsumerBuilder<string, Trade>(config with { PartitionAssignmentStrategy = PartitionAssignmentStrategy.CooperativeSticky })
    .SetPartitionsAssignedHandler((c, parts) =>
    {
        foreach (var tp in parts) _shards[tp.Partition] = ShardState.RestoreFromSnapshotAndChangelog(tp);   // before processing
    })
    .SetPartitionsRevokedHandler((c, parts) =>
    {
        foreach (var tp in parts)
        {
            _shards[tp.Partition.Value].Flush();               // persist state
            c.Commit(new[] { _shards[tp.Partition.Value].NextOffset(tp) });
            _shards.Remove(tp.Partition.Value);
        }
    })
    .Build();

// Per-partition single-threaded processing: no locks inside a shard
void Handle(ConsumeResult<string, Trade> r)
{
    var shard = _shards[r.Partition.Value];
    shard.Apply(r.Message.Value);                               // aggregate exposure per book
    _changelog.Produce(shard.ChangelogKey(r.Message.Key), shard.Snapshot(r.Message.Key));
}
~~~`,
  pts: [r`Locks and shared memory do not span pods: design ownership, routing and recovery.`, r`Ownership via Kafka partitions, actors, consistent hashing or lease tables.`, r`Flush and commit on revocation; restore before processing on assignment.`, r`Idempotency and fencing for handover duplicates; cooperative rebalancing.`, r`Cross-shard queries via scatter-gather or a separate read model.`],
  ex: r`A bank's intraday exposure aggregator outgrew its 96-core VM; the first attempt ran 10 pods sharing state through Redis with distributed locks and was slower than the VM. Re-architected around Kafka partition ownership with per-partition state and a compacted changelog, it scaled linearly and recovered a failed pod's shards in 20 seconds.`,
  fu: [r`How do you serve a query for one book while its shard is being restored?`, r`Consistent hashing vs Kafka partitions: when would you choose each?`, r`How do you size the number of partitions for future growth?`],
  pit: [r`Shared state in Redis guarded by distributed locks as the scaling strategy.`, r`Processing before state restore completes.`, r`Stop-the-world rebalances on every deploy.`] }
],
cheat: r`### Mental model
Thread = OS-scheduled stack; Task = promise; async method = state machine. Awaited I/O holds no thread. CPU-bound → pool/Parallel; I/O-bound → async all the way. Race = read-modify-write or check-then-act on shared state. Guarantees: atomicity, visibility, ordering (lock gives all three).

### Primitive picker
| Need | Use |
|---|---|
| short sync critical section | lock / .NET 9 Lock (private object; no I/O, no await) |
| async critical section or throttle | SemaphoreSlim (WaitAsync, Release in finally, not reentrant) |
| counter, flag, reference swap | Interlocked (CAS loop for custom updates) |
| stop flag | volatile / Volatile.Read |
| one-shot async signal | TaskCompletionSource (RunContinuationsAsynchronously) |
| producer/consumer | bounded Channel (FullMode, Complete, drain) |
| read-mostly data | immutable / FrozenDictionary snapshot + Volatile.Write |
| concurrent map | ConcurrentDictionary (GetOrAdd factory may run twice → Lazy) |
| per-key ordering | hash-partitioned lanes / Kafka key / actor |
| stampede | single-flight Lazy<Task<T>> per key, HybridCache |
| cross-process (one machine) | named Mutex / Semaphore |
| cross-pod | DB constraints, guarded UPDATE, sp_getapplock, leases + fencing |
| rate / concurrency limits | System.Threading.RateLimiting |

### Thread pool
Global FIFO + local LIFO queues + work stealing. Min threads = ProcessorCount (follows container CPU limit); hill climbing adds slowly. Starvation: low CPU, rising queue length, slow health checks → dump, find .Result/Wait; fix async; SetMinThreads only as a stopgap.

### Contexts
SynchronizationContext = where continuation runs (none in ASP.NET Core). ExecutionContext = AsyncLocal, Activity, culture (flows down, not up). ConfigureAwait(false) in libraries. SuppressFlow when starting long-lived work from a request. ThreadStatic does not survive await.

### Rules that prevent incidents
No mutable fields in singletons. No I/O or callbacks under locks. Canonical lock order. Never async void (except event handlers); never Parallel.ForEach with async lambdas (use ForEachAsync). StartNew + async lambda = Task<Task>. Bound every queue. Timeouts on every external await. Linked CTS for timeouts; distinguish timeout from caller cancel. TimeProvider for testable time. PeriodicTimer for loops (no overlap). Durable state before ack; drain on shutdown.

### Diagnose
| Symptom | Tool |
|---|---|
| plateau, spare CPU | monitor-lock-contention-count, ContentionStart traces, syncblk |
| low CPU, queue growing | threadpool-queue-length, dump grouped by Wait/GetResult |
| hang, zero CPU | two dumps; syncblk, clrstack -all, dumpasync |
| throughput drops as cores rise | false sharing: pad / stripe |
| p99.9 spikes | GC pauses, allocation rate, CPU throttling, HDR histograms |

### Memory model
Volatile read = acquire, write = release; lock/Interlocked = full fence. x64 strong, ARM64 weak: test on target hardware. Use Lazy<T> instead of hand-written double-checked locking.

### Numbers
L = λ·W. Wait ≈ S/(1−ρ): 80% util = 5×, 90% = 10×. Hot row max ≈ 1 / lock hold time. Queue delay = length / service rate. Cache line 64 B (pad 128).

### Design ladder
Stateless async + DB-enforced correctness → immutable snapshots → partitioned single-threaded lanes → actors → single-writer ring buffers on pinned cores. Escalate only with measurements.`
});
})(String.raw);
