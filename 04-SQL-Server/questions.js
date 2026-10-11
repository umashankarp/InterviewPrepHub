(function (r) {
registerTopic('04-sql-server', {
related: ['05-postgresql', '56-linq-efcore', '29-performance-engineering'],
questions: [
{ id: 'q1', level: 'Basic', tags: ['indexes'],
  code: r`~~~sql
CREATE TABLE dbo.Orders (
  OrderId    bigint IDENTITY(1,1) NOT NULL,
  PublicId   uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID(),
  CustomerId bigint NOT NULL,
  CreatedUtc datetime2(3) NOT NULL,
  Total      decimal(19,4) NOT NULL,
  CONSTRAINT PK_Orders PRIMARY KEY CLUSTERED (OrderId)            -- narrow, unique, static, ever-increasing
);
CREATE UNIQUE NONCLUSTERED INDEX UX_Orders_PublicId ON dbo.Orders (PublicId);   -- leaf carries OrderId as locator
CREATE NONCLUSTERED INDEX IX_Orders_Customer ON dbo.Orders (CustomerId, CreatedUtc DESC);
~~~`,
  q: r`What is the difference between a clustered and a non-clustered index?`,
  a: r`A **clustered index** *is* the table: the leaf level of the B+tree holds the data rows, sorted by the clustering key. There can be only one. A table without one is a **heap**.

A **non-clustered index** is a separate B+tree whose leaf rows hold the index key plus a **row locator**: the clustering key (if the table is clustered) or a RID (for heaps). Fetching columns not in the index requires a **key lookup** back into the clustered index.

Choosing the clustering key: **narrow, unique, static, ever-increasing** (e.g. {{BIGINT IDENTITY}}), because it is copied into every non-clustered index and drives page splits. A random {{UNIQUEIDENTIFIER}} ({{NEWID()}}) causes fragmentation and page splits; {{NEWSEQUENTIALID()}} or a bigint key avoids that.

A query is **covered** when one index holds every column it needs (no key lookup). {{INCLUDE}} columns live only at the leaf level, so they cover without widening the sorted key (16 columns / 1,700 bytes limit): key columns for seek and order, INCLUDE columns for retrieval.`,
  pts: [r`Clustered = the table, one per table`, r`Non-clustered leaf holds the clustering key`, r`Key lookups cost random I/O`, r`Narrow, unique, static, increasing clustering key`],
  ex: r`An orders table clustered on a {{NEWID()}} GUID had 99% fragmentation and heavy page splits; reclustering on {{BIGINT IDENTITY}} and keeping the GUID as a non-clustered unique key fixed insert latency.`,
  fu: [r`What is a heap and when is it acceptable?`, r`Why does a wide clustering key bloat every index?`],
  pit: [r`Saying "a clustered index is physically sorted on disk". Logically ordered by key; pages are linked, not necessarily contiguous.`],
  tip: r`Mention the clustering key being copied into every non-clustered index. It shows you understand the storage cost.` },

{ id: 'q2', level: 'Basic', tags: ['isolation'],
  code: r`~~~sql
ALTER DATABASE Shop SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;   -- RCSI: readers stop blocking writers
ALTER DATABASE Shop SET ALLOW_SNAPSHOT_ISOLATION ON;
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;
BEGIN TRAN;
  SELECT Balance FROM dbo.Accounts WHERE AccountId = 1;     -- consistent view for the whole transaction
  UPDATE dbo.Accounts SET Balance -= 10 WHERE AccountId = 1; -- error 3960 if another txn changed this row meanwhile
COMMIT;
~~~`,
  q: r`List SQL Server isolation levels and the anomalies each prevents.`,
  a: r`| Level | Dirty read | Non-repeatable read | Phantom | Mechanism |
|---|---|---|---|---|
| READ UNCOMMITTED / NOLOCK | possible | possible | possible | No shared locks |
| READ COMMITTED (default) | no | possible | possible | Short shared locks |
| READ COMMITTED SNAPSHOT (RCSI) | no | possible | possible | Row versions, statement-level snapshot |
| REPEATABLE READ | no | no | possible | Shared locks held to end |
| SNAPSHOT | no | no | no* | Transaction-level row versions; update conflicts error 3960 |
| SERIALIZABLE | no | no | no | Key-range locks |

*Snapshot gives a consistent view but can allow **write skew**.

Most OLTP systems should enable **RCSI**: readers do not block writers and vice versa, at the cost of tempdb version-store usage. Note {{NOLOCK}} can return rows twice, skip rows, or read uncommitted data that is later rolled back.`,
  pts: [r`Default is READ COMMITTED (locking)`, r`RCSI removes reader/writer blocking`, r`SNAPSHOT can raise update conflicts`, r`NOLOCK is not "faster safe reads"`],
  ex: r`Enabling RCSI on an order system removed most blocking chains between reporting reads and checkout writes.`,
  fu: [r`What is write skew?`, r`Why can NOLOCK miss rows or read them twice?`],
  pit: [r`Sprinkling NOLOCK to "fix" blocking.`] },

{ id: 'q3', level: 'Basic', tags: ['joins'],
  code: r`~~~sql
-- NOT IN with a NULL in the subquery returns no rows; NOT EXISTS is safe and usually a clean anti semi join
SELECT c.CustomerId FROM dbo.Customers c
WHERE NOT EXISTS (SELECT 1 FROM dbo.Orders o WHERE o.CustomerId = c.CustomerId);
-- CROSS APPLY: top-N per group (latest 3 orders per customer)
SELECT c.CustomerId, x.OrderId, x.CreatedUtc
FROM dbo.Customers c
CROSS APPLY (SELECT TOP (3) OrderId, CreatedUtc FROM dbo.Orders o WHERE o.CustomerId = c.CustomerId ORDER BY CreatedUtc DESC) x;
~~~`,
  q: r`Explain join types and the physical join algorithms SQL Server uses.`,
  a: r`Logical joins: {{INNER}}, {{LEFT/RIGHT/FULL OUTER}}, {{CROSS}}, plus {{CROSS APPLY}} / {{OUTER APPLY}} (correlated, like a lateral join), and semi/anti joins from {{EXISTS}} / {{NOT EXISTS}}.

Physical operators the optimiser picks:

- **Nested loops**: for each outer row, seek the inner. Best when the outer input is small and the inner is indexed.
- **Merge join**: both inputs sorted on the join key; linear. Great for large, pre-sorted inputs.
- **Hash match**: builds a hash table on the smaller input, probes with the other. Good for large unsorted inputs; needs a memory grant and spills to tempdb if under-estimated.
- **Adaptive join** (2017+, batch mode): decides between hash and nested loops at runtime based on actual row count.

Bad cardinality estimates are the usual reason for a wrong choice.`,
  pts: [r`Nested loops, merge, hash, adaptive`, r`Choice driven by estimates and indexes`, r`Hash spills = memory grant too small`, r`NOT EXISTS preferred over NOT IN with NULLs`],
  ex: r`A query chose nested loops expecting 10 rows but got 2 million; updating statistics switched it to a hash join and runtime fell from minutes to seconds.`,
  fu: [r`Why can NOT IN return no rows when the subquery contains NULL?`],
  pit: [r`Forcing join hints instead of fixing statistics or indexes.`] },

{ id: 'q4', level: 'Basic', tags: ['programmability', 'stored-procedures', 'functions', 'views', 'triggers'],
  q: r`Stored procedure, scalar function, table-valued function, view, trigger: what can each one do, what can it NOT do, and how does the engine execute it?`,
  a: r`These are the five programmable objects. The interview signal is knowing the **mechanism**: how each is compiled, inlined or cached, and the restrictions that follow from it.

| Object | Called by | Side effects (DML, DDL) | Transactions, TRY/CATCH, dynamic SQL | How the optimiser sees it |
|---|---|---|---|---|
| **Stored procedure** | {{EXEC}} | Yes | Yes | Own cached plan per statement; parameters are sniffed on first compile |
| **Scalar UDF** | Inside any expression | No (only table variables it owns) | No | Pre-2019: a black box run once per row; 2019+: may be inlined (Froid) |
| **Inline TVF** | {{FROM}} / {{APPLY}} | No | No | Expanded into the calling query like a parameterised view: full optimisation |
| **Multi-statement TVF** | {{FROM}} / {{APPLY}} | Only its own return table variable | No | Fills a table variable; fixed guess of 100 rows (interleaved execution fixes this in 2017+) |
| **View** | {{FROM}} | No | No | Text is expanded inline at compile time; an **indexed view** is materialised |
| **Trigger** | Implicitly by DML / DDL / logon | Yes | Runs **inside the caller's transaction** | Fires **once per statement**, with {{inserted}}/{{deleted}} sets |

### The restrictions follow from "functions must be side-effect free"
A UDF cannot modify permanent tables, call {{EXEC}} on a procedure, use dynamic SQL, create temp tables, use {{TRY/CATCH}}, or call side-effecting built-ins such as {{NEWID()}} or {{RAND()}} (wrap them in a view if you really must). That is what lets the optimiser call it any number of times, in any order, in a parallel plan.

### Practical rules a lead enforces
- **Procedures** are the unit of API, security ({{GRANT EXECUTE}} only) and transactions.
- **Inline TVFs** are the only function type that is reliably fast; treat scalar UDFs and multi-statement TVFs as suspects in every performance review.
- **Views** are for abstraction and security, not performance; nested views are a maintenance and optimisation trap.
- **Triggers** are hidden coupling: keep them for audit and invariants that constraints cannot express.`,
  code: r`~~~sql
-- Procedure: side effects, transaction, output parameter, return code
CREATE OR ALTER PROCEDURE dbo.Account_Debit @AccountId bigint, @Amount decimal(19,4), @NewBalance decimal(19,4) OUTPUT
AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  UPDATE dbo.Accounts SET @NewBalance = Balance = Balance - @Amount
  WHERE AccountId = @AccountId AND Balance >= @Amount;
  IF @@ROWCOUNT = 0 RETURN 1;          -- business status code; 0 = success
  RETURN 0;
END;
GO
-- Inline TVF: one SELECT, expanded into the caller, fully optimisable
CREATE OR ALTER FUNCTION dbo.tvf_OpenInvoices (@CustomerId bigint)
RETURNS TABLE WITH SCHEMABINDING AS
RETURN SELECT i.InvoiceId, i.DueDate, i.Amount - i.Paid AS Outstanding
       FROM dbo.Invoices i WHERE i.CustomerId = @CustomerId AND i.Amount > i.Paid;
GO
SELECT c.CustomerId, o.InvoiceId, o.Outstanding
FROM dbo.Customers c CROSS APPLY dbo.tvf_OpenInvoices(c.CustomerId) o;

-- A function may not have side effects
CREATE FUNCTION dbo.bad() RETURNS int AS BEGIN INSERT dbo.Log VALUES (1); RETURN 1; END;
-- Msg 443: Invalid use of a side-effecting operator 'INSERT' within a function.
~~~`,
  pts: [r`Procedures own side effects, transactions and security; functions must be side-effect free.`, r`Inline TVF is expanded like a parameterised view; multi-statement TVF and pre-2019 scalar UDFs are black boxes.`, r`Views are expanded at compile time; only indexed views are materialised.`, r`Triggers fire once per statement, inside the caller's transaction.`, r`GRANT EXECUTE on procedures as the application's only permission.`],
  ex: r`A payments platform exposed only stored procedures to the application login: when an SQL-injection bug was found in an admin tool, the login could not read any table directly, which limited the blast radius to what the procedures allowed.`,
  fu: [r`Why can a function not call NEWID(), and how do people work around it?`, r`Can a procedure be used in a SELECT? (INSERT ... EXEC, OPENROWSET, and why both are poor ideas.)`, r`What happens to the caller's transaction when a trigger raises an error?`],
  pit: [r`Saying "views improve performance" (only indexed views do).`, r`Treating all functions as equal: inline TVF and scalar UDF have completely different performance profiles.`, r`Assuming a trigger fires once per row.`],
  tip: r`Answer with the table, then say "and the reason for every restriction is that functions must be side-effect free so the optimiser can call them freely".` },

{ id: 'q5', level: 'Basic', tags: ['functions', 'null', 'three-valued-logic'],
  q: r`ISNULL vs COALESCE vs NULLIF vs IIF: how do they differ in type, evaluation and nullability? And why does NOT IN return nothing when the list contains a NULL?`,
  a: r`### Three-valued logic first
Any comparison with NULL is **UNKNOWN**, not FALSE. {{WHERE}} keeps only TRUE rows, so {{x = NULL}} and {{x <> NULL}} never match. {{x NOT IN (1, 2, NULL)}} expands to {{x <> 1 AND x <> 2 AND x <> NULL}}: the last term is UNKNOWN, so the whole predicate is never TRUE and **no rows** come back. Prefer {{NOT EXISTS}} (NULL-safe, compiles to an anti semi join). SQL Server 2022 adds {{IS [NOT] DISTINCT FROM}}, a NULL-safe equality.

### ISNULL vs COALESCE
| | {{ISNULL(a, b)}} | {{COALESCE(a, b, ...)}} |
|---|---|---|
| Standard | T-SQL only | ANSI |
| Arguments | exactly 2 | 2 or more |
| Result type | type of the **first** argument (silent truncation) | highest **precedence** type of all arguments |
| Evaluation | each argument once | rewritten to {{CASE}}: a subquery argument may run **twice** |
| Nullability of the result | NOT NULL if the replacement is not null | always nullable |

The nullability difference matters: {{ISNULL(col, 0)}} in a computed column is NOT NULL, so it can be part of a primary key; {{COALESCE}} cannot.

### NULLIF, IIF, CHOOSE, GREATEST, LEAST
- {{NULLIF(a, b)}} returns NULL when equal: the standard divide-by-zero guard {{x / NULLIF(y, 0)}}.
- {{IIF(cond, a, b)}} and {{CHOOSE(i, a, b, c)}} are shorthand for {{CASE}} (same type rules).
- {{GREATEST}} / {{LEAST}} (2022) take a list and **ignore NULLs**; before 2022 people used {{(SELECT MAX(v) FROM (VALUES (a),(b),(c)) t(v))}}.

### NULLs elsewhere
- Aggregates ignore NULLs: {{COUNT(col)}} vs {{COUNT(*)}}, and {{AVG}} averages only non-null values.
- {{'a' + NULL}} is NULL; {{CONCAT}} treats NULL as empty.
- A UNIQUE constraint in SQL Server allows only **one** NULL; use a filtered unique index ({{WHERE col IS NOT NULL}}) for "unique when present".
- Performance: {{WHERE ISNULL(Status, 0) = 0}} is non-SARGable; write {{WHERE Status = 0 OR Status IS NULL}}.`,
  code: r`~~~sql
DECLARE @code varchar(3) = NULL;
SELECT ISNULL(@code, 'UNKNOWN')   AS a,   -- 'UNK'  (typed as varchar(3): silent truncation)
       COALESCE(@code, 'UNKNOWN') AS b;   -- 'UNKNOWN'

-- COALESCE with a subquery is a CASE: the subquery can run twice (and return different values under READ COMMITTED)
SELECT COALESCE((SELECT MAX(Rate) FROM dbo.FxRates WHERE Ccy = 'EUR'), 1.0);

-- Nullability: only the ISNULL computed column can be a key
ALTER TABLE dbo.Trades ADD BookKey AS ISNULL(BookId, 0) PERSISTED;   -- NOT NULL

-- Divide-by-zero guard and NULL-safe comparison
SELECT Desk, 100.0 * Pnl / NULLIF(Notional, 0) AS ReturnPct FROM dbo.DeskPnl;
SELECT * FROM dbo.Accounts a JOIN dbo.AccountsStaging s ON s.AccountId = a.AccountId
WHERE a.BranchCode IS DISTINCT FROM s.BranchCode;                  -- 2022: NULL vs value counts as different

-- The NOT IN trap and the safe form
SELECT c.CustomerId FROM dbo.Customers c WHERE c.CustomerId NOT IN (SELECT CustomerId FROM dbo.Orders);  -- 0 rows if any NULL
SELECT c.CustomerId FROM dbo.Customers c WHERE NOT EXISTS (SELECT 1 FROM dbo.Orders o WHERE o.CustomerId = c.CustomerId);

-- "Unique if present"
CREATE UNIQUE INDEX UX_Customers_TaxId ON dbo.Customers (TaxId) WHERE TaxId IS NOT NULL;
~~~`,
  pts: [r`Comparisons with NULL are UNKNOWN; WHERE keeps only TRUE.`, r`NOT IN with any NULL returns nothing; use NOT EXISTS.`, r`ISNULL takes the first argument's type and can truncate; COALESCE uses type precedence.`, r`COALESCE is a CASE: subquery arguments may be evaluated twice.`, r`NULLIF guards division; GREATEST/LEAST ignore NULLs; IS DISTINCT FROM is NULL-safe equality.`],
  ex: r`A churn report using NOT IN returned zero lapsed customers because one guest-checkout order had a NULL CustomerId; NOT EXISTS returned the real 3,200. In the same codebase, ISNULL(@CurrencyCode, 'UNKNOWN') into a char(3) variable produced 'UNK', which later matched no currency.`,
  fu: [r`Why does COUNT(col) differ from COUNT(*)?`, r`How do you write a NULL-safe join before SQL Server 2022?`, r`Why does a UNIQUE constraint allow only one NULL, and how do you allow many?`],
  pit: [r`Writing = NULL instead of IS NULL.`, r`Wrapping indexed columns in ISNULL in WHERE clauses.`, r`Assuming ISNULL and COALESCE are interchangeable.`] },

{ id: 'q6', level: 'Basic', tags: ['functions', 'identity', 'sequence', 'output'],
  q: r`SCOPE_IDENTITY vs @@IDENTITY vs IDENT_CURRENT vs the OUTPUT clause: which do you use to get generated keys, and when do you use a SEQUENCE instead of IDENTITY?`,
  a: r`| Function | Scope | Trap |
|---|---|---|
| {{@@IDENTITY}} | last identity in **this session, any scope** | Returns the identity inserted by a **trigger** (e.g. an audit row), not yours |
| {{SCOPE_IDENTITY()}} | this session, **this scope** | Single value only; useless for multi-row inserts |
| {{IDENT_CURRENT('tbl')}} | last identity for the table, **any session** | Race condition: another session's value |
| {{OUTPUT inserted.Id}} | every row of this statement | The correct answer for multi-row inserts and for mapping source rows to new keys |

### Related system functions
- {{@@ROWCOUNT}} (and {{ROWCOUNT_BIG()}}) is reset by almost every statement, including {{IF}} and {{SET}}: capture it **immediately** into a variable.
- {{@@TRANCOUNT}}, {{XACT_STATE()}}, {{@@SPID}}, {{@@ERROR}} (legacy; use TRY/CATCH).

### IDENTITY behaviour
Values are **not** gapless: rollbacks, failed inserts and server restarts (identity cache of 1,000 for int) leave gaps. {{ALTER DATABASE SCOPED CONFIGURATION SET IDENTITY_CACHE = OFF}} reduces restart jumps at a throughput cost.

### SEQUENCE
A schema object independent of any table: {{NEXT VALUE FOR}} can be used in defaults, across several tables (one number space for trades and orders), or **before** the insert (the app knows the key up front). {{sp_sequence_get_range}} hands an application a block of numbers for bulk work. Sequences also have gaps (CACHE), so they are not suitable for gapless legal numbers either.

### Gapless numbering (invoices, cheque numbers)
Requires a counter row updated **inside the business transaction** ({{UPDATE ... SET @n = Next = Next + 1}}), which serialises writers. Ask whether the regulator really needs gapless numbers or just unique, monotonic and auditable ones.`,
  code: r`~~~sql
-- Multi-row insert: capture every generated key (and map it back to the source row)
DECLARE @map TABLE (SourceRef varchar(40), PaymentId bigint);
MERGE dbo.Payments AS t
USING dbo.PaymentsStaging AS s ON 1 = 0                      -- always insert; MERGE allows OUTPUT of source columns
WHEN NOT MATCHED THEN INSERT (AccountId, Amount, Currency) VALUES (s.AccountId, s.Amount, s.Currency)
OUTPUT s.SourceRef, inserted.PaymentId INTO @map;

-- Single row
INSERT dbo.Accounts (CustomerId, Currency) VALUES (@CustomerId, 'GBP');
DECLARE @id bigint = SCOPE_IDENTITY(), @rows int = @@ROWCOUNT;   -- capture immediately

-- Sequence shared by two tables; key known before the insert
CREATE SEQUENCE dbo.TradeNo AS bigint START WITH 1 INCREMENT BY 1 CACHE 100;
ALTER TABLE dbo.EquityTrades ADD CONSTRAINT DF_EqTradeNo DEFAULT (NEXT VALUE FOR dbo.TradeNo) FOR TradeNo;
DECLARE @first sql_variant, @last sql_variant;
EXEC sys.sp_sequence_get_range @sequence_name = N'dbo.TradeNo', @range_size = 1000,
     @range_first_value = @first OUTPUT, @range_last_value = @last OUTPUT;

-- Gapless invoice number: serialised by the counter row, inside the same transaction
BEGIN TRAN;
  DECLARE @inv int;
  UPDATE dbo.Counters SET @inv = NextValue = NextValue + 1 WHERE Name = 'Invoice-2026';
  INSERT dbo.Invoices (InvoiceNo, CustomerId, Amount) VALUES (@inv, @CustomerId, @Amount);
COMMIT;
~~~`,
  pts: [r`@@IDENTITY can return a trigger's identity; use SCOPE_IDENTITY for one row.`, r`OUTPUT inserted.* for multi-row inserts; MERGE ON 1 = 0 to map source rows to new keys.`, r`Capture @@ROWCOUNT immediately; nearly every statement resets it.`, r`IDENTITY and SEQUENCE both have gaps; gapless needs a counter row in the transaction.`, r`SEQUENCE: shared number space, key known before insert, sp_sequence_get_range for blocks.`],
  ex: r`An order service returned @@IDENTITY to the client; when an audit trigger was added, customers started receiving audit-row ids as order numbers. Switching to OUTPUT inserted.OrderId fixed it and also made the bulk import path return all keys.`,
  fu: [r`Why can you not use OUTPUT without INTO on a table that has triggers?`, r`How does EF Core get generated keys for a batch of inserts?`, r`How do you reseed an identity after a data migration?`],
  pit: [r`IDENT_CURRENT + 1 to "predict" the next key.`, r`Promising gapless identity values to the business.`, r`Reading @@ROWCOUNT after an IF or PRINT.`] },

{ id: 'q7', level: 'Intermediate', tags: ['execution-plans'],
  code: r`~~~sql
SET STATISTICS IO, TIME ON;
SELECT o.OrderId, o.Total FROM dbo.Orders o WHERE o.CustomerId = @c AND o.CreatedUtc >= @from;
-- Actual plan red flags: Estimated 1 vs Actual 2,000,000 rows; Key Lookup x 40,000; Sort/Hash spill warnings;
-- CONVERT_IMPLICIT in a seek predicate; Table/Clustered Index Scan for a selective filter
SELECT TOP (20) qs.total_logical_reads / qs.execution_count AS avg_reads, qp.query_plan
FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
ORDER BY avg_reads DESC;
~~~`,
  q: r`How do you read an execution plan, and what are the red flags?`,
  a: r`Read **right to left, top to bottom** (data flows leftward); compare **estimated vs actual rows** on each operator (use the actual plan or Query Store / {{SET STATISTICS IO, TIME ON}}).

Red flags:

- Large estimate vs actual mismatch (stale stats, parameter sniffing, non-SARGable predicates, table variables, multi-statement TVFs).
- **Key lookups** executed thousands of times.
- **Scans** of large tables where a seek was expected.
- **Implicit conversions** ({{CONVERT_IMPLICIT}}) on columns, killing index seeks.
- **Spills** to tempdb on sort/hash (warning icon), excessive memory grants.
- **Sort** operators on large inputs (missing index order).
- **Parallelism** on small queries, or serial plans caused by scalar UDFs.
- Warnings: missing index suggestions (treat as hints, not orders).

Logical reads (from STATISTICS IO) are the most stable metric to compare versions of a query.`,
  pts: [r`Estimated vs actual rows`, r`Lookups, scans, spills, implicit conversions`, r`Logical reads as the comparison metric`],
  ex: r`An {{nvarchar}} parameter compared to a {{varchar}} column caused CONVERT_IMPLICIT and a scan of 50M rows; fixing the parameter type restored the seek.`,
  fu: [r`What is a residual predicate?`],
  pit: [r`Trusting estimated cost percentages as if they were real time.`] },

{ id: 'q8', level: 'Intermediate', tags: ['sargability'],
  code: r`~~~sql
-- Non-SARGable: function on the column, implicit conversion, leading wildcard
WHERE YEAR(CreatedUtc) = 2026
WHERE CONVERT(date, CreatedUtc) = '2026-10-10'          -- (this one is actually SARGable via a special rule, but avoid relying on it)
WHERE AccountNumber = 12345                              -- varchar column vs int literal -> CONVERT_IMPLICIT scan
WHERE Email LIKE '%@example.com'
-- SARGable rewrites
WHERE CreatedUtc >= '2026-01-01' AND CreatedUtc < '2027-01-01'   -- half-open range
WHERE AccountNumber = '12345'
-- C#: match the parameter type to the column (varchar, not nvarchar)
cmd.Parameters.Add("@acct", SqlDbType.VarChar, 20).Value = acct;
~~~`,
  q: r`What does SARGable mean, and give examples of non-SARGable predicates.`,
  a: r`A predicate is **SARGable** (Search ARGument-able) when the engine can use an index seek on it: the column appears bare on one side.

Non-SARGable → fix:

| Bad | Good |
|---|---|
| {{WHERE YEAR(OrderDate) = 2026}} | {{WHERE OrderDate >= '2026-01-01' AND OrderDate < '2027-01-01'}} |
| {{WHERE LEFT(Name, 3) = 'Smi'}} | {{WHERE Name LIKE 'Smi%'}} |
| {{WHERE Amount * 1.1 > 100}} | {{WHERE Amount > 100 / 1.1}} |
| {{WHERE ISNULL(Status, 'X') = 'A'}} | {{WHERE Status = 'A'}} |
| {{WHERE Email LIKE '%@x.com'}} | Persisted computed column (reversed) or full-text |
| varchar column vs nvarchar parameter | Match parameter type to column |

Also: {{OR}} across different columns can block seeks (rewrite as {{UNION ALL}} or rely on index union), and functions in JOIN conditions have the same effect.`,
  pts: [r`Keep the column bare`, r`Ranges instead of functions on dates`, r`Match data types`, r`Computed columns for expressions`],
  ex: r`Rewriting {{CAST(CreatedAt AS date) = @d}} as a half-open range cut a query from 4 s to 30 ms. (SQL Server can sometimes seek on the date cast, but the explicit range is reliable.)`,
  fu: [r`How can a computed column be indexed?`],
  pit: [r`BETWEEN with datetime end-of-day boundaries instead of half-open ranges.`] },

{ id: 'q9', level: 'Intermediate', tags: ['statistics'],
  code: r`~~~sql
SELECT s.name, sp.last_updated, sp.rows, sp.rows_sampled, sp.modification_counter
FROM sys.stats s CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.object_id = OBJECT_ID('dbo.Orders');
UPDATE STATISTICS dbo.Orders IX_Orders_Customer WITH FULLSCAN;
-- ascending-key problem: new rows beyond the histogram are estimated badly; 2014+ CE helps, so do frequent updates
ALTER DATABASE SCOPED CONFIGURATION SET LEGACY_CARDINALITY_ESTIMATION = OFF;
~~~`,
  q: r`What are statistics, and why do stale statistics cause bad plans?`,
  a: r`Statistics are histograms (up to 200 steps) plus density information on columns/indexes. The optimiser uses them to **estimate row counts** (cardinality), which drive join type, memory grants, parallelism, and index choice.

Stale or coarse stats produce wrong estimates. Auto-update triggers after a threshold of modifications (dynamic threshold since 2016 compat level: roughly sqrt(1000 × rows) for large tables), which can still be too late for ascending keys (new dates fall beyond the histogram's last step).

Maintenance: keep {{AUTO_UPDATE_STATISTICS}} on (consider async for latency-sensitive OLTP), add scheduled updates for volatile large tables (Ola Hallengren's scripts), use {{FULLSCAN}} where sampling misleads, and create multi-column stats for correlated predicates. Inspect with {{DBCC SHOW_STATISTICS}} / {{sys.dm_db_stats_properties}}.`,
  pts: [r`Estimates drive every plan decision`, r`Auto-update threshold may lag`, r`Ascending-key problem`, r`Scheduled maintenance for hot tables`],
  ex: r`Nightly loads added a day of data beyond the histogram; morning queries estimated 1 row and chose nested loops until stats were updated post-load.`,
  fu: [r`What is the cardinality estimator version and how does compat level affect it?`],
  pit: [r`Rebuilding indexes daily "to fix performance" when it was the stats update that helped.`] },

{ id: 'q10', level: 'Intermediate', tags: ['parameter-sniffing'],
  code: r`~~~sql
CREATE OR ALTER PROCEDURE dbo.GetOrdersByCustomer @CustomerId bigint AS
SELECT OrderId, Total FROM dbo.Orders WHERE CustomerId = @CustomerId
OPTION (OPTIMIZE FOR (@CustomerId UNKNOWN));     -- or RECOMPILE for highly skewed, infrequent queries
-- Query Store: force the known-good plan while you fix the root cause
EXEC sp_query_store_force_plan @query_id = 4711, @plan_id = 12;
-- SQL Server 2022: Parameter Sensitive Plan optimization keeps multiple plans per skew bucket
ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SENSITIVE_PLAN_OPTIMIZATION = ON;
~~~`,
  q: r`What is parameter sniffing and how do you fix a bad case?`,
  a: r`On first compile, SQL Server optimises a parameterised query for the **values passed that time** and caches the plan. If data is skewed (one customer with 5 million orders, most with 10), the cached plan may be terrible for other values.

Fixes, roughly in order of preference:

1. **Better indexing** so one plan is good for all values.
2. **{{OPTION (RECOMPILE)}}** for infrequent, expensive queries (compile cost every time).
3. **{{OPTIMIZE FOR (@p = value)}}** or **{{OPTIMIZE FOR UNKNOWN}}** (density-based average plan).
4. **Query Store plan forcing** of a known-good plan (and monitor it).
5. **Parameter Sensitive Plan optimisation (SQL Server 2022, compat 160)**: caches multiple plans per predicate value range automatically.
6. Splitting into separate procedures/branches for known outlier classes.

Avoid "local variable" tricks without understanding them (they also produce a density-based plan).`,
  pts: [r`Plan built for first values`, r`Skew makes it hurt`, r`RECOMPILE, OPTIMIZE FOR, Query Store forcing`, r`PSP optimisation in 2022`],
  ex: r`A dashboard was fast for small merchants and timed out for the largest; Query Store showed two plans and forcing the hash-join plan stabilised it.`,
  fu: [r`How do you detect parameter sniffing in production?`],
  pit: [r`Clearing the whole plan cache (DBCC FREEPROCCACHE) as a fix.`] },

{ id: 'q11', level: 'Intermediate', tags: ['locking', 'blocking'],
  code: r`~~~sql
-- Who is blocking whom right now?
SELECT r.session_id, r.blocking_session_id, r.wait_type, r.wait_time, t.text
FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.blocking_session_id <> 0;
EXEC sp_WhoIsActive @find_block_leaders = 1, @get_locks = 1;
-- Escalation (~5,000 locks on one object): batch big updates
WHILE 1 = 1
BEGIN
  UPDATE TOP (4000) dbo.Orders SET Archived = 1 WHERE CreatedUtc < '2024-01-01' AND Archived = 0;
  IF @@ROWCOUNT = 0 BREAK;
END
~~~`,
  q: r`Explain locking, lock escalation and how to investigate blocking.`,
  a: r`SQL Server takes locks at row/key, page, and object level with modes **S** (shared), **U** (update), **X** (exclusive), **IS/IX** (intent), **Sch-S/Sch-M** (schema). Locks are held according to isolation level; X locks until commit.

**Lock escalation**: when one statement holds about 5,000 locks on an object, SQL Server tries to escalate to a table (or partition) lock, which can block everyone. Mitigate by batching large modifications, indexing so fewer rows are touched, or {{LOCK_ESCALATION = AUTO}} on partitioned tables.

Investigate blocking: {{sys.dm_exec_requests}} ({{blocking_session_id}}, {{wait_type}}), {{sys.dm_tran_locks}}, {{sp_WhoIsActive}}, the **blocked process report** (Extended Events) and Query Store wait stats. Find the **head blocker**: often an open transaction waiting on the application (a long transaction with a network call inside).`,
  pts: [r`Lock modes and intent locks`, r`Escalation at ~5,000 locks`, r`Find the head blocker`, r`Long transactions are the usual cause`],
  ex: r`The head blocker was a transaction left open while the API called a payment provider for 20 seconds; moving the call outside the transaction removed the blocking.`,
  fu: [r`What is the difference between blocking and deadlock?`],
  pit: [r`Holding transactions across network calls or user think time.`] },

{ id: 'q12', level: 'Intermediate', tags: ['deadlocks'],
  code: r`~~~sql
-- Capture deadlock graphs from the built-in system_health session
SELECT CAST(event_data AS xml) AS deadlock
FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL)
WHERE object_name = 'xml_deadlock_report';
~~~
~~~csharp
// Fix the cause (consistent order, indexes, short txns) and retry the victim (error 1205)
var retry = new ResiliencePipelineBuilder().AddRetry(new RetryStrategyOptions
{
    ShouldHandle = new PredicateBuilder().Handle<SqlException>(e => e.Number == 1205),
    MaxRetryAttempts = 3, BackoffType = DelayBackoffType.Exponential, UseJitter = true
}).Build();
await retry.ExecuteAsync(async ct => await transfers.ExecuteAsync(cmd, ct), ct);
~~~`,
  q: r`How do deadlocks happen and how do you resolve them?`,
  a: r`A deadlock is a cycle: session A holds a lock B needs while B holds one A needs. The lock monitor detects it (every few seconds or faster when frequent) and kills the cheapest victim with **error 1205**.

Common causes: transactions touching tables in different orders; a key lookup vs an update on the same index (reader holds non-clustered, writer holds clustered); missing indexes causing scans that lock many rows; SERIALIZABLE range locks; upgrade patterns (read then update without {{UPDLOCK}}).

Resolution:

1. Capture the **deadlock graph** (system_health XE session has it by default).
2. Fix root causes: consistent access order, covering indexes to remove lookups, shorter transactions, {{UPDLOCK}} for read-then-write, RCSI to remove reader participation.
3. **Retry** the victim transaction in the application (with backoff) because some deadlocks remain possible.`,
  pts: [r`Cycle of waits; 1205 victim`, r`Deadlock graph from system_health`, r`Consistent order, covering indexes, short transactions`, r`Application retry for 1205`],
  ex: r`~~~sql
BEGIN TRAN;
SELECT Balance FROM dbo.Accounts WITH (UPDLOCK, HOLDLOCK) WHERE Id = @id; -- prevents read-then-update deadlock
UPDATE dbo.Accounts SET Balance = Balance - @amt WHERE Id = @id;
COMMIT;
~~~`,
  fu: [r`Why does a key lookup cause deadlocks with updates?`],
  pit: [r`Using NOLOCK to "fix" deadlocks.`] },

{ id: 'q13', level: 'Intermediate', tags: ['functions', 'udf', 'performance'],
  q: r`Scalar UDF, multi-statement TVF and inline TVF: why do the first two so often destroy performance, what did SQL Server 2017/2019 change, and how do you rewrite them?`,
  a: r`### Scalar UDF (classic)
- Executed **once per row** through a separate execution context; 10 million rows means 10 million invocations.
- If it reads tables, every call is a hidden query, invisible in the estimated plan cost (the plan says "0%").
- Pre-2019 it **forces the whole query serial** (no parallelism).
- Without {{WITH SCHEMABINDING}} the optimiser assumes it may read data, which can add Halloween-protection spools to updates.

**SQL Server 2019 scalar UDF inlining (Froid)** rewrites eligible UDFs into the calling query as relational expressions. Check {{sys.sql_modules.is_inlineable}}. Not inlineable when, among other things, the UDF calls a time-dependent built-in ({{GETDATE()}}), uses table variables, loops in some forms, uses {{EXECUTE AS}}, or is called in {{GROUP BY}}. A UDF that was inlined can silently stop being inlined after an innocent edit, so verify it in tests.

### Multi-statement TVF (MSTVF)
Fills a **table variable** and returns it. The optimiser has no statistics: fixed estimate of 1 row (pre-2014) or 100 rows (2014+), leading to nested loops over millions of rows. **Interleaved execution** (2017, compat 140) pauses optimisation, runs the MSTVF, and uses the real row count for the rest of the plan, but only for read-only queries and only on the first compile.

### Inline TVF
A single {{RETURN SELECT}}. It is expanded into the caller like a view with parameters: real statistics, parallelism, predicate push-down, join elimination. **This is the target form for nearly every rewrite.**

### Rewrite recipe
1. Turn the scalar UDF into an inline TVF that returns one column and one row.
2. Call it with {{CROSS APPLY}} (or {{OUTER APPLY}} to keep rows when it returns nothing).
3. Convert MSTVF logic into one {{SELECT}} with CTEs; procedural branches become {{CASE}} or {{UNION ALL}} with mutually exclusive predicates.
4. Add {{WITH SCHEMABINDING}} to functions that touch no data, so they are marked deterministic and precise.`,
  code: r`~~~sql
-- Before: scalar UDF reading data, called per row, query forced serial
CREATE OR ALTER FUNCTION dbo.fn_CustomerExposure (@CustomerId bigint) RETURNS decimal(19,4)
AS BEGIN
  RETURN (SELECT SUM(Notional) FROM dbo.OpenPositions WHERE CustomerId = @CustomerId);
END;
GO
SELECT c.CustomerId, dbo.fn_CustomerExposure(c.CustomerId) AS Exposure FROM dbo.Customers c;  -- 2M hidden queries

-- Is it inlineable (2019+)?
SELECT OBJECT_NAME(object_id) AS fn, is_inlineable FROM sys.sql_modules WHERE object_id = OBJECT_ID('dbo.fn_CustomerExposure');

-- After: inline TVF + APPLY; one set-based plan, parallel, with real estimates
CREATE OR ALTER FUNCTION dbo.itvf_CustomerExposure (@CustomerId bigint)
RETURNS TABLE WITH SCHEMABINDING AS
RETURN SELECT SUM(p.Notional) AS Exposure FROM dbo.OpenPositions p WHERE p.CustomerId = @CustomerId;
GO
SELECT c.CustomerId, e.Exposure
FROM dbo.Customers c OUTER APPLY dbo.itvf_CustomerExposure(c.CustomerId) e;

-- Pure computation: schemabound, deterministic, cheap (and usable in a persisted computed column)
CREATE OR ALTER FUNCTION dbo.fn_BasisPoints (@rate decimal(9,6)) RETURNS decimal(12,2)
WITH SCHEMABINDING, RETURNS NULL ON NULL INPUT AS
BEGIN RETURN @rate * 10000; END;

-- Find the worst UDFs in production
SELECT TOP (20) OBJECT_NAME(object_id) AS fn, execution_count, total_worker_time / 1000 AS cpu_ms
FROM sys.dm_exec_function_stats ORDER BY total_worker_time DESC;
~~~`,
  pts: [r`Classic scalar UDFs run per row, hide their cost and force serial plans.`, r`MSTVF: table variable, fixed 100-row estimate; interleaved execution helps only partly.`, r`Inline TVF is expanded into the caller: the form to standardise on.`, r`2019 Froid inlining is conditional; check sys.sql_modules.is_inlineable and test it.`, r`sys.dm_exec_function_stats shows which UDFs burn CPU.`],
  ex: r`A risk report called a scalar exposure UDF for 2 million customers and ran 47 minutes serially. Rewriting it as an inline TVF with OUTER APPLY gave a parallel hash aggregate plan that ran in 38 seconds.`,
  fu: [r`What makes a function deterministic, and why does that matter for computed columns and indexed views?`, r`How do you turn an MSTVF with IF/ELSE branches into an inline TVF?`, r`Why does adding GETDATE() to a UDF stop it from being inlined?`],
  pit: [r`Trusting the estimated plan cost of a query that calls a scalar UDF.`, r`Putting a data-reading scalar UDF in a WHERE clause or a CHECK constraint.`, r`Assuming compatibility level 150 inlines every UDF.`],
  trade: r`Scalar UDFs give reuse and readability; inline TVFs give the same reuse with set-based performance but slightly clumsier call syntax. For pure arithmetic on a few columns, a persisted computed column is often better than either.` },

{ id: 'q14', level: 'Intermediate', tags: ['stored-procedures', 'error-handling', 'transactions'],
  q: r`Write a production-grade stored procedure template. Explain TRY/CATCH, THROW vs RAISERROR, XACT_ABORT, XACT_STATE, nested transactions and the errors that CATCH never sees.`,
  a: r`### The template
{{SET NOCOUNT ON}} (no "rows affected" chatter), {{SET XACT_ABORT ON}}, one {{BEGIN TRAN}} inside {{BEGIN TRY}}, and in {{CATCH}}: roll back if {{@@TRANCOUNT > 0}}, then {{THROW;}} to re-raise the original error to the caller.

### Why XACT_ABORT ON is non-negotiable
When a **client command timeout** fires, the client sends an *attention* signal: the batch stops, **CATCH does not run**, and without XACT_ABORT the transaction stays **open** on the pooled connection, holding locks until the next user of that connection commits or rolls back. With XACT_ABORT ON, the server rolls it back. XACT_ABORT also makes most runtime errors abort and roll back the whole transaction instead of continuing with the next statement.

### Errors TRY/CATCH does not catch
- Attention / client timeout and {{KILL}}.
- Severity 20+ errors that end the connection.
- Compile errors and deferred-name-resolution errors **in the same scope** (a missing table in the procedure itself); they are caught one level up.

### THROW vs RAISERROR
| | {{THROW}} | {{RAISERROR}} |
|---|---|---|
| Re-raise original | {{THROW;}} keeps number, message, line | No: you rebuild the message |
| Aborts batch | Yes; honours XACT_ABORT | No, execution continues |
| Severity | always 16 | chosen; {{WITH NOWAIT}} flushes progress messages immediately |
| Message formatting | use {{FORMATMESSAGE}} | printf-style {{%s %d}} |

The previous statement must end with {{;}} before {{THROW}}.

### Error functions
{{ERROR_NUMBER()}}, {{ERROR_MESSAGE()}}, {{ERROR_SEVERITY()}}, {{ERROR_STATE()}}, {{ERROR_LINE()}}, {{ERROR_PROCEDURE()}}: valid only inside CATCH. {{XACT_STATE()}} = 1 committable, -1 doomed (you can only roll back), 0 no transaction.

### Nested transactions are an illusion
Inner {{COMMIT}} just decrements {{@@TRANCOUNT}}; any {{ROLLBACK}} rolls back **everything** to the outermost BEGIN. For "undo only my part" use {{SAVE TRANSACTION}} when the caller already has a transaction and the transaction is still committable.

### Logging errors that survive the rollback
Rows inserted into a log table inside the transaction are rolled back with it. Write the log **after** the rollback in CATCH, or capture details in a table variable (table variables ignore rollback).`,
  dia: r`flowchart TD
  A[EXEC proc] --> B[SET NOCOUNT ON and XACT_ABORT ON]
  B --> C[BEGIN TRY then BEGIN TRAN]
  C --> D{statements succeed}
  D -- yes --> E[COMMIT]
  D -- runtime error --> F[CATCH block]
  F --> G{@@TRANCOUNT greater than 0}
  G -- yes --> H[ROLLBACK]
  G -- no --> I[log error]
  H --> I --> J[THROW to caller]
  D -- client timeout --> K[attention: CATCH skipped, XACT_ABORT rolls back]`,
  code: r`~~~sql
CREATE OR ALTER PROCEDURE dbo.Payment_Post
  @RequestId uniqueidentifier, @FromAccount bigint, @ToAccount bigint, @Amount decimal(19,4)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF @Amount <= 0 THROW 50001, 'Amount must be positive', 1;

  DECLARE @startedTran bit = 0;
  BEGIN TRY
    IF @@TRANCOUNT = 0 BEGIN BEGIN TRAN; SET @startedTran = 1; END
    ELSE SAVE TRANSACTION PaymentPost;                       -- caller owns the transaction

    INSERT dbo.PaymentRequests (RequestId, CreatedUtc) VALUES (@RequestId, SYSUTCDATETIME());  -- idempotency key
    UPDATE dbo.Accounts SET Balance -= @Amount WHERE AccountId = @FromAccount AND Balance >= @Amount;
    IF @@ROWCOUNT = 0 THROW 50002, 'Insufficient funds', 1;
    UPDATE dbo.Accounts SET Balance += @Amount WHERE AccountId = @ToAccount;

    IF @startedTran = 1 COMMIT;
  END TRY
  BEGIN CATCH
    IF @startedTran = 1 AND @@TRANCOUNT > 0 ROLLBACK;
    ELSE IF XACT_STATE() = 1 ROLLBACK TRANSACTION PaymentPost;   -- undo only our part
    INSERT dbo.ErrorLog (Proc, Number, Message, Line, LoggedUtc)    -- after rollback, so it persists
    VALUES (ERROR_PROCEDURE(), ERROR_NUMBER(), ERROR_MESSAGE(), ERROR_LINE(), SYSUTCDATETIME());
    THROW;                                                           -- re-raise the original error
  END CATCH
END;
GO
-- Progress messages from a long admin script appear immediately
RAISERROR('Batch %d of %d done', 0, 1, 7, 40) WITH NOWAIT;
~~~`,
  pts: [r`SET NOCOUNT ON; SET XACT_ABORT ON; TRY + TRAN; CATCH: rollback if @@TRANCOUNT, then THROW.`, r`Client timeouts skip CATCH; only XACT_ABORT prevents an orphaned open transaction.`, r`THROW re-raises the original error and aborts; RAISERROR continues and supports WITH NOWAIT.`, r`Nested COMMIT only decrements @@TRANCOUNT; ROLLBACK undoes everything; use SAVE TRANSACTION.`, r`Log errors after rollback or via a table variable.`],
  ex: r`A card-authorisation service saw lock chains every afternoon: a 30-second client timeout hit a procedure without XACT_ABORT, the transaction stayed open on the pooled connection, and later requests on that connection ran inside it. Adding XACT_ABORT ON to every procedure (enforced by a lint rule) ended the incidents.`,
  fu: [r`What does XACT_STATE() = -1 mean, and what can you still do?`, r`How does a .NET SqlTransaction interact with a procedure that also calls BEGIN TRAN?`, r`Why must the statement before THROW end with a semicolon?`],
  pit: [r`Swallowing the error in CATCH (no THROW), so the caller thinks it succeeded.`, r`Logging inside the transaction and losing the log on rollback.`, r`Relying on @@ERROR after each statement in new code.`],
  tip: r`Mention the client-timeout case unprompted. It is the bug most senior candidates have seen in production and few can explain.` },

{ id: 'q15', level: 'Intermediate', tags: ['temp-tables', 'table-variables', 'tvp', 'tempdb'],
  q: r`Temp table vs table variable vs CTE vs table-valued parameter: how does each behave for statistics, recompiles, transactions and tempdb, and how do you pass 10,000 rows from .NET to a procedure?`,
  a: r`| | {{#temp}} | {{@table}} | CTE | TVP |
|---|---|---|---|---|
| Storage | tempdb | tempdb (not "in memory") | none: inlined query text | tempdb (or memory-optimised type) |
| Statistics | **yes**, auto-created | **no** column stats | n/a | no column stats |
| Cardinality | real | 1 row (pre-2019); actual count at first compile with **deferred compilation** (2019) | n/a | actual count at first compile |
| Indexes | any | inline PK/UNIQUE/INDEX only | n/a | inline in the type |
| Rolled back by ROLLBACK | yes | **no** | n/a | read-only |
| Causes recompiles | yes, on stats thresholds | rarely | n/a | rarely |
| Parallel inserts | yes | no (pre-2019 serial modifications) | n/a | n/a |
| Scope | session / proc and children | batch | single statement | parameter |

### Rules of thumb
- **Temp table** for intermediate results that are large or joined further: statistics give good plans.
- **Table variable** for small sets, for data that must survive a rollback (error logging), and in hot procedures where recompiles hurt.
- **CTE** is not materialised: referenced twice means computed twice. Use a temp table to compute once.
- **TVP** for passing sets from the application: one round trip, strongly typed, set-based inside.

### Temp table caching
Procedures cache and reuse temp table structures (less tempdb allocation contention) only if you do not run DDL on them after creation and do not create **named** constraints. Under heavy load, tempdb allocation page contention ({{PAGELATCH}} on PFS/GAM/SGAM) is fixed with multiple equal data files, and in 2019+ with memory-optimised tempdb metadata.

### Passing rows from .NET
| Option | When |
|---|---|
| TVP | 10s to 100,000s of rows into a set-based procedure |
| {{SqlBulkCopy}} into a staging table | 100,000s+ rows, fastest, minimally logged |
| JSON parameter + {{OPENJSON}} | flexible shape, no type to deploy, slower |
| Many single inserts | never for bulk |`,
  code: r`~~~sql
-- TVP type and a set-based procedure
CREATE TYPE dbo.PaymentRow AS TABLE (
  SourceRef varchar(40) NOT NULL PRIMARY KEY, AccountId bigint NOT NULL, Amount decimal(19,4) NOT NULL);
GO
CREATE OR ALTER PROCEDURE dbo.Payments_Import @rows dbo.PaymentRow READONLY AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  -- Large intermediate: temp table so the next join gets statistics
  SELECT r.SourceRef, r.AccountId, r.Amount, a.Currency
  INTO #valid
  FROM @rows r JOIN dbo.Accounts a ON a.AccountId = r.AccountId AND a.Status = 'Open';
  CREATE INDEX IX_valid_Account ON #valid (AccountId);   -- note: DDL after creation disables temp table caching

  INSERT dbo.Payments (SourceRef, AccountId, Amount, Currency)
  SELECT v.SourceRef, v.AccountId, v.Amount, v.Currency FROM #valid v
  WHERE NOT EXISTS (SELECT 1 FROM dbo.Payments p WHERE p.SourceRef = v.SourceRef);
END;
GO
-- Table variables ignore rollback: useful for keeping diagnostics
DECLARE @diag TABLE (Msg nvarchar(400));
BEGIN TRAN; INSERT @diag VALUES (N'step 1 done'); ROLLBACK;
SELECT * FROM @diag;   -- still one row
~~~
~~~csharp
// .NET: send 10,000 rows in one round trip
var table = new DataTable();
table.Columns.Add("SourceRef", typeof(string));
table.Columns.Add("AccountId", typeof(long));
table.Columns.Add("Amount", typeof(decimal));
foreach (var p in payments) table.Rows.Add(p.Ref, p.AccountId, p.Amount);

await using var cmd = new SqlCommand("dbo.Payments_Import", conn) { CommandType = CommandType.StoredProcedure };
cmd.Parameters.Add(new SqlParameter("@rows", SqlDbType.Structured) { TypeName = "dbo.PaymentRow", Value = table });
await cmd.ExecuteNonQueryAsync(ct);
~~~`,
  pts: [r`Temp tables have statistics; table variables do not (deferred compilation in 2019 only fixes the row count).`, r`Table variables survive ROLLBACK; temp tables do not.`, r`CTEs are inlined, not materialised; referenced twice means run twice.`, r`TVP for sets from .NET; SqlBulkCopy for very large loads; JSON for flexible shapes.`, r`tempdb contention: multiple data files, memory-optimised metadata, avoid DDL on cached temp tables.`],
  ex: r`A settlement procedure that looped over 8,000 rows sent one call each from .NET (8,000 round trips, 40 s). A TVP plus one set-based INSERT ... SELECT completed in 300 ms.`,
  fu: [r`Why can changing a TVP type be painful to deploy, and how do you version it?`, r`When would a memory-optimised table type help?`, r`How does a CTE referenced twice show up in the execution plan?`],
  pit: [r`"Table variables live in memory": they live in tempdb like temp tables.`, r`Joining a 1-million-row table variable on SQL Server 2017 and getting a 1-row estimate.`, r`Using ##global temp tables for cross-session data and hitting name collisions.`] },

{ id: 'q16', level: 'Intermediate', tags: ['functions', 'date-time', 'time-zones'],
  q: r`Walk through the date and time types and built-in functions you rely on (DATEADD, DATEDIFF, EOMONTH, DATETRUNC, DATE_BUCKET, AT TIME ZONE...). What are the traps in financial systems?`,
  a: r`### Types
| Type | Precision | Use |
|---|---|---|
| {{datetime}} | rounded to .000/.003/.007 s | legacy only; {{'23:59:59.999'}} rounds to the next day |
| {{datetime2(n)}} | 100 ns, 6 to 8 bytes | default for timestamps, stored in **UTC** |
| {{datetimeoffset(n)}} | + UTC offset | when the original local offset matters (trade capture at an exchange) |
| {{date}} / {{time}} | | business dates (value date, settlement date), times of day |

### Current time
{{SYSUTCDATETIME()}} (datetime2, UTC) for stored timestamps; {{SYSDATETIMEOFFSET()}} with offset; {{GETDATE()}} / {{SYSDATETIME()}} are **server local time** and change meaning when the server or the cloud region moves. All of them are evaluated **once per statement** (a 10-million-row update gets one value).

### Arithmetic and parts
- {{DATEADD(month, 1, '2026-01-31')}} = {{2026-02-28}}: month arithmetic clamps to month end; adding 1 month twice is not the same as adding 2.
- {{DATEDIFF(unit, a, b)}} counts **boundaries crossed**, not elapsed units: {{DATEDIFF(year, '2025-12-31', '2026-01-01')}} = 1. Age and tenure need an explicit birthday check. {{DATEDIFF_BIG}} avoids int overflow for milliseconds.
- {{EOMONTH(d, offset)}}, {{DATEFROMPARTS}}, {{DATETIMEFROMPARTS}}.
- {{DATETRUNC(month, d)}} (2022) truncates; {{DATE_BUCKET(minute, 5, ts)}} (2022) groups into fixed buckets (5-minute OHLC bars).
- {{DATEPART(weekday, d)}} depends on {{SET DATEFIRST}} and {{DATENAME}} on {{SET LANGUAGE}}: session settings can change results. Use {{DATEPART(iso_week, d)}} and arithmetic from a known Monday for deterministic weeks.

### Time zones
{{AT TIME ZONE}} converts using Windows zone names from {{sys.time_zone_info}} and handles daylight saving. Applied to a **datetime2** it *assigns* the offset; applied to a **datetimeoffset** it *converts*. To report a UTC column in London time: {{ts AT TIME ZONE 'UTC' AT TIME ZONE 'GMT Standard Time'}}. It is CPU-heavy on large sets; a calendar or zone-offset table is faster for reports.

### Performance
Never wrap the column: {{YEAR(OrderDate) = 2026}} scans. Use **half-open ranges** {{OrderDate >= '2026-01-01' AND OrderDate < '2027-01-01'}}. ({{CAST(col AS date) = @d}} is a special case the optimiser can still seek on, but do not rely on it for other functions.) Avoid {{BETWEEN}} with timestamps: it includes the end boundary and misses fractions.

### Financial-systems traps
- Business date vs system timestamp: a trade booked at 23:30 New York time belongs to that day's book, which is the next UTC day. Store both.
- Month-end and cut-off logic belongs in a **calendar table** (business days, holidays per market, quarter end), not in nested DATEADD expressions.
- {{FORMAT()}} for display is CLR-based and 10 to 50 times slower than {{CONVERT}} with a style; format in the application.`,
  code: r`~~~sql
SELECT DATEADD(month, 1, CAST('2026-01-31' AS date))                 AS PlusOneMonth,   -- 2026-02-28
       DATEDIFF(year, '2025-12-31', '2026-01-01')                    AS BoundaryYears,  -- 1, not 0
       EOMONTH('2026-02-10')                                         AS MonthEnd,       -- 2026-02-28
       EOMONTH('2026-02-10', -1)                                     AS PrevMonthEnd,
       DATETRUNC(quarter, SYSUTCDATETIME())                          AS QuarterStart,   -- 2022+
       DATEPART(iso_week, '2026-01-01')                              AS IsoWeek;

-- Exact age in years (DATEDIFF alone is wrong before the birthday)
SELECT DATEDIFF(year, @dob, @asOf)
       - CASE WHEN DATEADD(year, DATEDIFF(year, @dob, @asOf), @dob) > @asOf THEN 1 ELSE 0 END AS Age;

-- 5-minute OHLC bars from ticks (2022+)
SELECT Symbol, DATE_BUCKET(minute, 5, TradeTimeUtc) AS Bar,
       MIN(Price) AS Low, MAX(Price) AS High, SUM(Qty) AS Volume
FROM dbo.Ticks
WHERE TradeTimeUtc >= @from AND TradeTimeUtc < @to            -- half-open, SARGable
GROUP BY Symbol, DATE_BUCKET(minute, 5, TradeTimeUtc);

-- UTC column shown as New York business date
SELECT TradeId,
       CAST(ExecutedUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Eastern Standard Time' AS date) AS NyTradeDate
FROM dbo.Trades;

-- Next settlement date T+2 business days, from a calendar table
SELECT c.CalDate FROM dbo.Calendar c
WHERE c.Market = 'XNYS' AND c.IsBusinessDay = 1 AND c.CalDate > @tradeDate
ORDER BY c.CalDate OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY;
~~~`,
  pts: [r`Store timestamps as datetime2 in UTC (SYSUTCDATETIME); business dates as date.`, r`DATEDIFF counts boundaries crossed; month DATEADD clamps to month end.`, r`DATETRUNC and DATE_BUCKET (2022) for truncation and fixed buckets.`, r`AT TIME ZONE assigns on datetime2, converts on datetimeoffset; handles DST.`, r`Half-open ranges on the raw column; calendar tables for business days and cut-offs.`],
  ex: r`An interest-accrual job used DATEDIFF(month, ...) to count accrual periods; loans opened on the 31st were charged a full month after one day. Rebuilding it on a calendar table with explicit day counts (ACT/365) fixed the overcharge and produced a customer remediation of 1.2 million rows.`,
  fu: [r`How would you build and populate a calendar table with market holidays?`, r`Why does datetime round '23:59:59.999' up to the next day?`, r`How do you handle a DST transition hour in hourly reporting?`],
  pit: [r`GETDATE() in a cloud database whose server time zone you do not control.`, r`BETWEEN '2026-01-01' AND '2026-01-31' on a timestamp column (drops most of 31 January).`, r`FORMAT() on millions of rows.`] },

{ id: 'q17', level: 'Intermediate', tags: ['functions', 'strings', 'collation'],
  q: r`Which string functions do you actually use (STRING_AGG, STRING_SPLIT, CONCAT_WS, TRIM, TRANSLATE, CHARINDEX, PATINDEX...), and what do collation and varchar vs nvarchar change about them?`,
  a: r`### The modern toolkit
| Need | Function | Note |
|---|---|---|
| Join rows into a list | {{STRING_AGG(x, ',') WITHIN GROUP (ORDER BY ...)}} | 2017+; replaces the {{FOR XML PATH + STUFF}} trick. Cast to {{nvarchar(max)}} or it fails past 8,000 bytes |
| Split a list | {{STRING_SPLIT(s, ',', 1)}} | single-character separator; output order is **not guaranteed** unless you pass {{enable_ordinal}} (2022) and use {{ordinal}} |
| Concatenate | {{CONCAT}}, {{CONCAT_WS(sep, ...)}} | NULL becomes empty; CONCAT_WS skips NULLs, so no double separators |
| Trim | {{TRIM}}, {{LTRIM}}, {{RTRIM}} | 2022 adds a character list: {{TRIM('0' FROM acct)}} |
| Replace many chars | {{TRANSLATE(s, '()-', '   ')}} | one pass instead of nested REPLACE |
| Find | {{CHARINDEX}}, {{PATINDEX('%[^0-9]%', s)}} | PATINDEX takes LIKE patterns: validate "digits only" |
| Extract | {{LEFT}}, {{RIGHT}}, {{SUBSTRING}}, {{STUFF}} (insert or mask) | |
| Length | {{LEN}} ignores **trailing** spaces; {{DATALENGTH}} counts bytes | nvarchar is 2 bytes per char |
| Others | {{REPLICATE}}, {{REVERSE}}, {{UPPER}}, {{LOWER}}, {{QUOTENAME}}, {{STRING_ESCAPE}}, {{SOUNDEX}}/{{DIFFERENCE}} | QUOTENAME for dynamic identifiers |

### Collation decides comparisons
The default {{..._CI_AS}} collation is case and trailing-space insensitive: {{'abc' = 'ABC  '}} is true. Use {{COLLATE Latin1_General_BIN2}} for exact matching (API keys, hashes, IBANs), and a case-sensitive collation on columns where case is meaningful. Comparing columns with different collations raises a conflict error; temp tables take **tempdb's** collation, a classic bug in databases whose collation differs from the server's (use {{COLLATE DATABASE_DEFAULT}}).

### varchar vs nvarchar
nvarchar stores Unicode (names, addresses); varchar with a UTF-8 collation (2019) also stores Unicode at 1 byte for ASCII. The real danger is **mixing** them: an {{nvarchar}} parameter against a {{varchar}} column converts the column (data type precedence) and turns a seek into a scan. In .NET set {{SqlDbType.VarChar}} with the right size, or EF Core {{IsUnicode(false)}}.

### Searching
{{LIKE 'abc%'}} can seek; {{LIKE '%abc'}} cannot. For "contains" on large text use full-text search, a reversed persisted column for suffix search, or an external search index. Any function on the column in WHERE ({{UPPER(Email) = ...}}) is non-SARGable: put the normalised value in a **persisted computed column** and index it.`,
  code: r`~~~sql
-- Comma list of accounts per customer, ordered, no 8,000-byte failure
SELECT CustomerId,
       STRING_AGG(CAST(AccountNo AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY AccountNo) AS Accounts
FROM dbo.Accounts GROUP BY CustomerId;

-- Split with guaranteed order (2022)
SELECT value AS Tag, ordinal FROM STRING_SPLIT(N'fx,rates,emea', N',', 1) ORDER BY ordinal;

-- Address line without double separators when parts are NULL
SELECT CONCAT_WS(', ', Line1, Line2, City, PostCode) AS Address FROM dbo.Customers;

-- Normalise a phone number and validate an account number
SELECT REPLACE(TRANSLATE(Phone, '()-.', '    '), ' ', '') AS Digits,
       CASE WHEN PATINDEX('%[^0-9]%', AccountNo) = 0 AND LEN(AccountNo) = 8 THEN 1 ELSE 0 END AS IsValid
FROM dbo.Customers;

-- Mask a card number (keep last 4)
SELECT STUFF(Pan, 1, LEN(Pan) - 4, REPLICATE('*', LEN(Pan) - 4)) AS Masked FROM dbo.CardsStaging;

-- Exact, case-sensitive comparison for an API key
SELECT ClientId FROM dbo.ApiClients WHERE ApiKey = @key COLLATE Latin1_General_BIN2;

-- Make case-insensitive email lookups SARGable
ALTER TABLE dbo.Customers ADD EmailNorm AS LOWER(TRIM(Email)) PERSISTED;
CREATE INDEX IX_Customers_EmailNorm ON dbo.Customers (EmailNorm);

-- Temp table collation conflict fix
CREATE TABLE #codes (Code varchar(10) COLLATE DATABASE_DEFAULT);
~~~`,
  pts: [r`STRING_AGG (cast to max) and STRING_SPLIT with ordinal replace the old XML tricks.`, r`CONCAT_WS skips NULLs; TRANSLATE replaces many characters in one pass.`, r`LEN ignores trailing spaces; DATALENGTH counts bytes.`, r`Collation drives equality; BIN2 for exact matches; temp tables use tempdb's collation.`, r`nvarchar parameter vs varchar column causes CONVERT_IMPLICIT and scans.`],
  ex: r`A KYC lookup by passport number took 1.8 s because the .NET code sent nvarchar(4000) against a varchar(20) indexed column; the plan showed CONVERT_IMPLICIT and an index scan of 40 million rows. Typing the parameter as varchar(20) brought it to 2 ms.`,
  fu: [r`How did people do STRING_AGG before 2017, and what was wrong with it?`, r`Why can a UTF-8 collation make a varchar column smaller than nvarchar?`, r`How would you implement fuzzy name matching for sanctions screening?`],
  pit: [r`Relying on STRING_SPLIT output order without enable_ordinal.`, r`Assuming = is case-sensitive.`, r`LIKE '%term%' on a 100-million-row table in an OLTP path.`] },

{ id: 'q18', level: 'Intermediate', tags: ['functions', 'conversion', 'math', 'money'],
  q: r`CAST vs CONVERT vs PARSE vs TRY_CONVERT, data type precedence and implicit conversion, and the maths functions: how do you get money arithmetic exactly right in T-SQL?`,
  a: r`### Conversion functions
| Function | Use |
|---|---|
| {{CAST(x AS type)}} | ANSI, the default |
| {{CONVERT(type, x, style)}} | when you need a style: 23 or 112 for dates, 126 for ISO 8601, 1 or 2 for binary to hex |
| {{PARSE(x AS type USING culture)}} | culture-aware text parsing; CLR-based and slow; use only for small inputs |
| {{TRY_CAST}}, {{TRY_CONVERT}}, {{TRY_PARSE}} | return **NULL** instead of failing: validate staging data in one set-based pass |

{{ISNUMERIC}} is a trap: it returns 1 for {{'$'}}, {{'.'}}, {{'1e5'}}, {{'-'}}. Use {{TRY_CONVERT(decimal(19,4), x) IS NOT NULL}}.

### Data type precedence and implicit conversion
When two types meet, the lower-precedence side is converted (for example varchar to nvarchar, varchar to int, int to decimal). If the **column** is the side converted, every row is converted: the index cannot seek, and a bad value raises an error halfway through. Look for {{CONVERT_IMPLICIT}} warnings in plans and in Query Store. Typical causes: nvarchar parameters on varchar columns, numeric strings compared with int, and ORMs sending default lengths.

### Money arithmetic
- Use **decimal(19,4)** (or the currency's minor-unit scale), never {{float}} or {{real}}: {{0.1 + 0.2}} is not 0.3 in binary floating point.
- {{money}} is fixed at 4 decimal places and **loses precision in division and multiplication** intermediate results; prefer decimal.
- **int / int is integer division**: {{7 / 2 = 3}}. Multiply by {{1.0}} or cast first.
- Decimal result scale follows precision rules: multiplying two {{decimal(38,10)}} values cannot fit, so SQL Server reduces scale (to a minimum of 6) to protect the integer part. FX rate times amount can silently lose digits: cast to sensible precisions first, e.g. {{decimal(19,4) * decimal(19,10)}}.
- {{ROUND(x, 2)}} rounds half away from zero; {{ROUND(x, 2, 1)}} **truncates**. There is no built-in banker's rounding; implement it explicitly when a scheme requires it.
- Allocation (splitting 100.00 three ways) must give the remainder to one leg so the legs sum exactly to the total.

### Maths functions
{{ABS}}, {{SIGN}}, {{CEILING}}, {{FLOOR}}, {{POWER}}, {{SQRT}}, {{SQUARE}}, {{EXP}}, {{LOG(x, base)}}, {{LOG10}}, {{PI}}, {{RAND}} (one value per statement unless seeded per row), {{CRYPT_GEN_RANDOM}} for secure random bytes. Compounding: {{POWER(1 + rate/12, n)}} with decimals; for a product of returns use {{EXP(SUM(LOG(1 + r)))}} because there is no PRODUCT aggregate.`,
  code: r`~~~sql
-- Validate a staging file in one pass: bad rows identified, nothing fails
SELECT RowNo, RawAmount, RawDate,
       TRY_CONVERT(decimal(19,4), RawAmount)                AS Amount,
       TRY_CONVERT(date, RawDate, 112)                      AS ValueDate,     -- yyyymmdd
       CASE WHEN TRY_CONVERT(decimal(19,4), RawAmount) IS NULL THEN 'bad amount'
            WHEN TRY_CONVERT(date, RawDate, 112) IS NULL     THEN 'bad date' END AS Error
FROM stg.BankStatementLines;

SELECT ISNUMERIC('$') AS IsNum, TRY_CONVERT(decimal(19,4), '$') AS Converted;   -- 1 and NULL

-- Integer division and float error
SELECT 7 / 2 AS IntDiv, 7 * 1.0 / 2 AS DecDiv,
       CAST(0.1 AS float) + CAST(0.2 AS float) AS FloatSum;                  -- 3, 3.5, 0.30000000000000004

-- Rounding modes
SELECT ROUND(2.345, 2) AS HalfAwayFromZero, ROUND(2.345, 2, 1) AS Truncated;  -- 2.350, 2.340

-- Banker's rounding (half to even) to 2 dp
DECLARE @x decimal(19,6) = 2.345;
SELECT CASE WHEN ABS(@x * 100 - FLOOR(@x * 100)) = 0.5 AND CAST(FLOOR(@x * 100) AS bigint) % 2 = 0
            THEN FLOOR(@x * 100) / 100 ELSE ROUND(@x, 2) END AS BankersRounded;   -- 2.34

-- Split 100.00 into 3 legs that sum exactly
WITH legs AS (SELECT n FROM (VALUES (1),(2),(3)) v(n))
SELECT n, ROUND(100.00 / 3, 2, 1) + CASE WHEN n = 1 THEN 100.00 - 3 * ROUND(100.00 / 3, 2, 1) ELSE 0 END AS Leg
FROM legs;                                                                   -- 33.34, 33.33, 33.33

-- Product of daily returns (no PRODUCT aggregate)
SELECT PortfolioId, EXP(SUM(LOG(1 + DailyReturn))) - 1 AS CumulativeReturn
FROM dbo.DailyReturns WHERE DailyReturn > -1 GROUP BY PortfolioId;
~~~`,
  pts: [r`CAST by default, CONVERT for styles, TRY_ variants for validation; avoid PARSE and ISNUMERIC.`, r`Implicit conversion of the column side kills seeks: watch CONVERT_IMPLICIT.`, r`decimal for money; float and money types lose precision.`, r`int/int truncates; decimal multiplication can reduce scale to 6.`, r`ROUND(x, n, 1) truncates; banker's rounding and allocation remainders are explicit code.`],
  ex: r`A fee engine multiplied decimal(38,12) balances by decimal(38,12) rates; SQL Server reduced the result scale to 6, and rounding differences of up to 0.000001 per row accumulated to 4,300 GBP a month in reconciliation breaks. Casting inputs to decimal(19,4) and decimal(19,10) fixed it.`,
  fu: [r`Why does SQL Server convert the varchar column rather than the int literal?`, r`How would you do FX conversion with triangulation through USD without accumulating rounding error?`, r`What is wrong with the money data type in division?`],
  pit: [r`float columns for balances.`, r`ISNUMERIC for validation.`, r`Rounding each line and expecting the rounded lines to sum to the rounded total.`] },

{ id: 'q19', level: 'Senior', tags: ['t-sql', 'query', 'ranking-functions', 'top-n-per-group', 'duplicates'],
  q: r`Ranking functions in practice: Nth highest salary per department, top earner with ties, latest 3 orders per customer, and deleting duplicates. When is ROW_NUMBER wrong, and when does APPLY beat it?`,
  a: r`### The four ranking functions on salaries 100, 100, 90, 80
| Function | Result | Use for |
|---|---|---|
| {{ROW_NUMBER()}} | 1, 2, 3, 4 | exactly one row per position: dedupe, paging, "pick one" |
| {{RANK()}} | 1, 1, 3, 4 | competition ranking: ties share, gaps follow |
| {{DENSE_RANK()}} | 1, 1, 2, 3 | Nth **distinct** value |
| {{NTILE(4)}} | 1, 2, 3, 4 | quartiles and deciles (bucket sizes differ by at most one) |

Ask first: "Nth distinct salary, or Nth employee?" Then:
- **Nth highest salary per department**: {{DENSE_RANK() OVER (PARTITION BY DepartmentId ORDER BY Salary DESC) = @N}}. For a single value that must be NULL when missing, wrap {{OFFSET @N-1 ROWS FETCH NEXT 1 ROWS ONLY}} over DISTINCT salaries in a scalar subquery.
- **Top earner per department with ties**: {{RANK() = 1}}; ROW_NUMBER silently drops a tied person, which is a bug in anything bonus- or compliance-related.
- **Latest 3 orders per customer**: {{ROW_NUMBER() <= 3}} or {{OUTER APPLY (SELECT TOP (3) ...)}}.
- **Deduplicate, keeping one survivor**: {{ROW_NUMBER() OVER (PARTITION BY business key ORDER BY survivor rule)}} and {{DELETE FROM cte WHERE rn > 1}} (SQL Server deletes through a single-table CTE). Re-point child foreign keys to the survivor first, then add a unique index so duplicates cannot return.

### ROW_NUMBER vs APPLY for top-N per group
| | ROW_NUMBER filtered | OUTER APPLY + TOP (N) |
|---|---|---|
| Reads | the whole table once (or the whole index) | N rows per outer row via seeks |
| Wins when | most groups are needed, few rows per group | few groups, or many rows per group |
| Plan | Segment + Sequence Project (+ sort if no index) | Nested loops + Top per group |

Both need an index on {{(group, sort key DESC, unique tiebreaker)}} to avoid a sort. Always add a unique tiebreaker to the ORDER BY: without it ROW_NUMBER is **non-deterministic** and results change between runs and between plan shapes.

### TOP WITH TIES
{{SELECT TOP (1) WITH TIES ... ORDER BY ...}} returns every row tied with the last one. Combined with {{ORDER BY ROW_NUMBER() OVER (...)}} it is a compact "first row per group" without a derived table, though usually not faster.`,
  code: r`~~~sql
-- Nth highest distinct salary per department; departments without one appear as NULL
DECLARE @N int = 2;
WITH ranked AS (
  SELECT DepartmentId, Name, Salary,
         DENSE_RANK() OVER (PARTITION BY DepartmentId ORDER BY Salary DESC) AS rnk
  FROM dbo.Employees WHERE Salary IS NOT NULL)
SELECT d.Name AS Department, r.Name, r.Salary
FROM dbo.Departments d LEFT JOIN ranked r ON r.DepartmentId = d.DepartmentId AND r.rnk = @N;

-- Single Nth value, NULL if it does not exist
SELECT (SELECT DISTINCT Salary FROM dbo.Employees WHERE Salary IS NOT NULL
        ORDER BY Salary DESC OFFSET @N - 1 ROWS FETCH NEXT 1 ROWS ONLY) AS NthHighest;

-- Top earner(s) per department, ties kept
SELECT DepartmentId, Name, Salary
FROM (SELECT DepartmentId, Name, Salary, RANK() OVER (PARTITION BY DepartmentId ORDER BY Salary DESC) AS rk
      FROM dbo.Employees) x WHERE rk = 1;

-- Latest 3 orders for VIP customers: seek per customer
SELECT c.CustomerId, t.OrderId, t.OrderDate, t.Total
FROM dbo.Customers c
OUTER APPLY (SELECT TOP (3) o.OrderId, o.OrderDate, o.Total FROM dbo.Orders o
             WHERE o.CustomerId = c.CustomerId ORDER BY o.OrderDate DESC, o.OrderId DESC) t
WHERE c.Segment = 'VIP';
CREATE INDEX IX_Orders_Cust_Date ON dbo.Orders (CustomerId, OrderDate DESC, OrderId DESC) INCLUDE (Total);

-- Deduplicate customers by normalised email, keep the oldest; prevent recurrence
WITH d AS (SELECT ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(Email)) ORDER BY CustomerId) AS rn FROM dbo.Customers)
DELETE FROM d WHERE rn > 1;
ALTER TABLE dbo.Customers ADD EmailKey AS LOWER(TRIM(Email)) PERSISTED;
CREATE UNIQUE INDEX UX_Customers_EmailKey ON dbo.Customers (EmailKey) WHERE EmailKey IS NOT NULL;

-- Customer value quartiles
SELECT CustomerId, LifetimeValue, NTILE(4) OVER (ORDER BY LifetimeValue DESC) AS Quartile FROM dbo.CustomerValue;
~~~`,
  pts: [r`ROW_NUMBER unique; RANK ties with gaps; DENSE_RANK ties without gaps; NTILE buckets.`, r`Nth highest distinct value = DENSE_RANK; NULL-when-missing via scalar OFFSET subquery.`, r`ROW_NUMBER scans once; APPLY + TOP seeks per group: choose by group count and size.`, r`Unique tiebreaker in every ranking ORDER BY.`, r`Dedupe via ROW_NUMBER CTE, re-point children, then a unique index.`],
  ex: r`A "recent activity" API for 2,000 VIP customers over 50 million orders went from a 9-second ROW_NUMBER scan to 40 ms with OUTER APPLY and a matching index. In the same quarter a bonus report using ROW_NUMBER for "top trader per desk" dropped one of two equally ranked traders; RANK fixed it.`,
  fu: [r`Return the second order only for each customer.`, r`How does batch mode on rowstore change the ROW_NUMBER plan?`, r`How would you dedupe a 2-billion-row table without blocking OLTP?`],
  pit: [r`ROW_NUMBER where ties must be kept.`, r`ORDER BY without a unique tiebreaker.`, r`CROSS APPLY dropping customers with no orders when they should appear.`] },

{ id: 'q20', level: 'Senior', tags: ['performance', 'diagnosis'],
  code: r`~~~sql
EXEC sp_WhoIsActive @get_plans = 1;                                         -- 1. what is running now
SELECT TOP (10) wait_type, wait_time_ms - signal_wait_time_ms AS resource_wait_ms     -- 2. what are we waiting on
FROM sys.dm_os_wait_stats ORDER BY resource_wait_ms DESC;
-- 3. what changed: deploys, stats, plans -> Query Store "Regressed queries"
SELECT TOP (10) q.query_id, rs.avg_duration, rs.last_execution_time, p.plan_id
FROM sys.query_store_runtime_stats rs JOIN sys.query_store_plan p ON p.plan_id = rs.plan_id
JOIN sys.query_store_query q ON q.query_id = p.query_id ORDER BY rs.avg_duration DESC;
~~~`,
  q: r`A SQL Server suddenly becomes slow. Walk through your investigation.`,
  a: r`### Triage (minutes)
1. **What is running now**: {{sp_WhoIsActive}} / {{sys.dm_exec_requests}}: blocking chains, long runners, wait types.
2. **Waits**: {{sys.dm_os_wait_stats}} deltas or Query Store wait stats: CPU ({{SOS_SCHEDULER_YIELD}}), I/O ({{PAGEIOLATCH_*}}, {{WRITELOG}}), locks ({{LCK_M_*}}), memory grants ({{RESOURCE_SEMAPHORE}}), tempdb ({{PAGELATCH}}), parallelism ({{CXPACKET/CXCONSUMER}}).
3. **What changed**: deployment, data volume, stats, plan changes (**Query Store regressed queries**), configuration, failover, maintenance jobs.

### Narrow
- **Query Store**: top resource consumers and plan changes over time; force the previous good plan as an immediate mitigation.
- Host: CPU, memory pressure (page life expectancy, memory grants pending), storage latency.

### Fix and prevent
Fix the root cause (index, stats, query rewrite, transaction length), then add alerts on the leading indicator you found.`,
  pts: [r`Current activity, waits, changes`, r`Query Store regressed queries`, r`Force good plan as mitigation`, r`Alert on the leading indicator`],
  ex: r`Query Store showed a plan change after a stats update; forcing the old plan restored service in minutes while the index fix shipped.`,
  fu: [r`What does RESOURCE_SEMAPHORE indicate?`],
  pit: [r`Restarting SQL Server, which loses the evidence and empties the cache.`] },

{ id: 'q21', level: 'Senior', tags: ['query-store'],
  code: r`~~~sql
ALTER DATABASE Payments SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE, QUERY_CAPTURE_MODE = AUTO,
  MAX_STORAGE_SIZE_MB = 4096, INTERVAL_LENGTH_MINUTES = 15, WAIT_STATS_CAPTURE_MODE = ON);
-- Queries with more than one plan where the latest is slower
SELECT q.query_id, COUNT(DISTINCT p.plan_id) AS plans, MAX(rs.avg_duration) AS worst_avg_us
FROM sys.query_store_query q JOIN sys.query_store_plan p ON p.query_id = q.query_id
JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
GROUP BY q.query_id HAVING COUNT(DISTINCT p.plan_id) > 1 ORDER BY worst_avg_us DESC;
EXEC sp_query_store_force_plan @query_id = 4711, @plan_id = 12;
~~~`,
  q: r`What is Query Store and how do you use it in production?`,
  a: r`Query Store (on by default for new databases since SQL Server 2022) persists **query text, plans, runtime stats and wait stats** over time inside the database.

Uses:

- **Regression detection**: "Regressed Queries" report shows queries whose performance worsened after a plan change.
- **Plan forcing**: pin a known-good plan; SQL Server 2022 adds **Query Store hints** to apply options (e.g. {{RECOMPILE}}, {{MAXDOP}}) without code changes.
- **Upgrade safety**: capture baselines before changing compatibility level, then compare.
- **Top consumers** by CPU, duration, reads, waits.
- On readable secondaries (2022) for read workloads.

Operational care: size limits and cleanup policy ({{QUERY_CAPTURE_MODE = AUTO}}), monitor forced plans (they can fail if an index is dropped), and treat forcing as a mitigation while fixing the root cause.`,
  pts: [r`History of plans and runtime`, r`Force plans and hints without code changes`, r`Baseline before upgrades`],
  ex: r`Raising compat level to 160 regressed three queries; Query Store hints restored them in minutes while the team rewrote them.`,
  fu: [r`What happens to a forced plan if its index is dropped?`],
  pit: [r`Forcing plans and forgetting them for years.`] },

{ id: 'q22', level: 'Senior', tags: ['partitioning'],
  code: r`~~~sql
CREATE PARTITION FUNCTION pfMonthly (datetime2(3)) AS RANGE RIGHT FOR VALUES ('2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01');
CREATE PARTITION SCHEME psMonthly AS PARTITION pfMonthly ALL TO ([PRIMARY]);
CREATE TABLE dbo.AuditEvents (Id bigint IDENTITY, OccurredUtc datetime2(3) NOT NULL, Payload nvarchar(max),
  CONSTRAINT PK_Audit PRIMARY KEY CLUSTERED (OccurredUtc, Id)) ON psMonthly (OccurredUtc);
-- Retention in seconds instead of a multi-hour DELETE
TRUNCATE TABLE dbo.AuditEvents WITH (PARTITIONS (1));
ALTER PARTITION FUNCTION pfMonthly() MERGE RANGE ('2026-08-01');
~~~`,
  q: r`When and how do you use table partitioning?`,
  a: r`Partitioning splits one table into partitions by a key (usually date) via a **partition function** and **scheme**; queries see one table.

Real benefits are **manageability**, not raw query speed:

- **Sliding window**: {{SWITCH}} out an old partition (metadata-only) and {{TRUNCATE TABLE ... WITH (PARTITIONS)}} instead of deleting billions of rows.
- Per-partition index rebuilds, compression, and filegroups on cheaper storage for cold data.
- Partition elimination for queries filtered on the key.
- Lock escalation to partition level.

Costs: every query without the partition key touches all partitions; unique indexes must include the partition key (aligned); more complex maintenance. Do not partition small tables; first prove that indexes are insufficient.`,
  pts: [r`Manageability first`, r`SWITCH for instant archive`, r`Queries must filter on the key`, r`Aligned indexes include the key`],
  ex: r`A 4 TB transaction-history table partitioned monthly purges a month in seconds with SWITCH instead of an 8-hour delete.`,
  fu: [r`How do you add a new partition boundary without long locks?`],
  pit: [r`Partitioning expecting faster point lookups.`] },

{ id: 'q23', level: 'Senior', tags: ['columnstore', 'analytics'],
  code: r`~~~sql
-- Real-time operational analytics: rowstore for OLTP + nonclustered columnstore for aggregates
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Orders ON dbo.Orders (CustomerId, CreatedUtc, Status, Total)
WITH (COMPRESSION_DELAY = 30);   -- keep hot rows in the delta store briefly
SELECT Status, COUNT(*), SUM(Total) FROM dbo.Orders WHERE CreatedUtc >= DATEADD(day, -30, SYSUTCDATETIME()) GROUP BY Status;  -- batch mode
~~~`,
  q: r`Rowstore versus columnstore indexes, and real-time operational analytics.`,
  a: r`**Rowstore** (B-tree) stores rows together: ideal for OLTP point reads and small range scans.

**Columnstore** stores each column separately in compressed segments (about a million rows per rowgroup) and processes them in **batch mode**: huge compression (often 10x) and fast aggregations over many rows, with segment elimination. Weak for single-row lookups and frequent updates (deletes are marked in a delete bitmap; updates are delete + insert; trickle inserts land in delta stores).

Patterns:

- Clustered columnstore for fact tables / data warehouses.
- **Non-clustered columnstore on an OLTP table** ("real-time operational analytics") to run reports without a separate warehouse, at some write cost.
- Batch mode on rowstore (2019+) gives some benefit without columnstore.

Maintain by keeping rowgroups healthy (bulk load ≥102,400 rows per batch to compress directly) and reorganising to merge small rowgroups.`,
  pts: [r`Columnstore = compression + batch mode`, r`Bad for point updates`, r`NCCI for operational analytics`, r`Bulk load in large batches`],
  ex: r`A 2-billion-row fact table shrank from 900 GB to 80 GB and month-to-date aggregates went from minutes to seconds.`,
  fu: [r`What is segment elimination?`],
  pit: [r`Using clustered columnstore for an OLTP table with single-row updates.`] },

{ id: 'q24', level: 'Senior', tags: ['concurrency', 'patterns'],
  q: r`How do you implement a reliable queue table or "claim next job" pattern in SQL Server?`,
  a: r`Use {{UPDLOCK, READPAST, ROWLOCK}} so competing workers skip rows locked by others and atomically claim work:

~~~sql
WITH next AS (
  SELECT TOP (10) * FROM dbo.Jobs WITH (UPDLOCK, READPAST, ROWLOCK)
  WHERE Status = 'Ready' AND AvailableAt <= SYSUTCDATETIME()
  ORDER BY AvailableAt, Id)
UPDATE next SET Status = 'Processing', LockedBy = @worker, LockedUntil = DATEADD(minute, 5, SYSUTCDATETIME())
OUTPUT inserted.Id, inserted.Payload;
-- index: (Status, AvailableAt, Id)
~~~

Add: a lease ({{LockedUntil}}) so crashed workers' jobs are reclaimed; attempt counts and a dead-letter status; idempotent processing; deletion/archiving of completed rows in batches to keep the table small. This is also how outbox relays poll. At higher scale use a real broker.`,
  pts: [r`UPDLOCK + READPAST`, r`Lease and reclaim`, r`Attempts and dead-letter`, r`Keep the table small`],
  ex: r`An outbox relay with READPAST let 8 workers publish 5,000 messages per second without blocking each other.`,
  fu: [r`Why does ordering by AvailableAt need a supporting index?`],
  pit: [r`SELECT then UPDATE in two statements without locks: two workers take the same job.`] },

{ id: 'q25', level: 'Senior', tags: ['t-sql', 'query', 'gaps-and-islands'],
  q: r`Gaps and islands: find users who logged in on 3 or more consecutive days, and find missing invoice numbers.`,
  a: r`### Islands (consecutive runs)
The trick: for consecutive dates, {{date - ROW_NUMBER()}} is constant within a run. Group by that difference to get each island's start, end and length.

1. De-duplicate to one row per user per day (several logins a day would break the arithmetic).
2. {{grp = DATEADD(day, -ROW_NUMBER() OVER (PARTITION BY UserId ORDER BY LoginDate), LoginDate)}}.
3. {{GROUP BY UserId, grp HAVING COUNT(*) >= 3}}.

### Gaps (missing values)
Use {{LEAD}} to compare each value with the next: where {{next - current > 1}} there is a gap from {{current + 1}} to {{next - 1}}. This avoids generating a full number series.

### Variants interviewers ask
- Longest streak per user: the max island length.
- Periods where a server status stayed the same (islands on a status column): use {{ROW_NUMBER}} per user minus {{ROW_NUMBER}} per user and status.
- Session-ising events with a 30-minute inactivity gap: {{LAG}} to flag a new session when the gap exceeds 30 minutes, then a running {{SUM}} of the flags gives a session number.`,
  code: r`~~~sql
-- Users with 3+ consecutive login days
WITH days AS (SELECT DISTINCT UserId, CAST(LoginAt AS date) AS d FROM dbo.Logins),
grp AS (SELECT UserId, d, DATEADD(day, -ROW_NUMBER() OVER (PARTITION BY UserId ORDER BY d), d) AS g FROM days)
SELECT UserId, MIN(d) AS StreakStart, MAX(d) AS StreakEnd, COUNT(*) AS Days
FROM grp GROUP BY UserId, g HAVING COUNT(*) >= 3;

-- Missing invoice numbers (gaps)
SELECT InvoiceNo + 1 AS GapStart, NextNo - 1 AS GapEnd
FROM (SELECT InvoiceNo, LEAD(InvoiceNo) OVER (ORDER BY InvoiceNo) AS NextNo FROM dbo.Invoices) x
WHERE NextNo - InvoiceNo > 1;

-- Sessions: new session after 30 minutes of inactivity
WITH e AS (
  SELECT UserId, EventAt,
         CASE WHEN DATEDIFF(minute, LAG(EventAt) OVER (PARTITION BY UserId ORDER BY EventAt), EventAt) <= 30 THEN 0 ELSE 1 END AS NewSession
  FROM dbo.Events),
s AS (SELECT *, SUM(NewSession) OVER (PARTITION BY UserId ORDER BY EventAt ROWS UNBOUNDED PRECEDING) AS SessionNo FROM e)
SELECT UserId, SessionNo, MIN(EventAt) AS Started, MAX(EventAt) AS Ended, COUNT(*) AS Events
FROM s GROUP BY UserId, SessionNo;
~~~`,
  pts: [r`For consecutive values, value minus ROW_NUMBER is constant per island.`, r`De-duplicate to one row per entity per day first.`, r`LEAD finds gaps without generating a number series.`, r`LAG plus a running SUM of "new group" flags builds sessions.`, r`All three run as single scans with an index on (UserId, date).`],
  ex: r`A fraud team used the islands pattern to find cards used on 5+ consecutive days in new countries; a compliance team used the gaps query to prove invoice numbering had no unexplained gaps for an audit.`,
  fu: [r`Find each user's longest streak.`, r`How do you handle time zones when "day" depends on the user's locale?`],
  pit: [r`Forgetting DISTINCT per day, so two logins on one day break the run.`, r`Using a cursor or loop instead of set-based logic.`],
  tip: r`Name the technique ("gaps and islands") before solving. It signals you have seen the class of problem.` },

{ id: 'q26', level: 'Senior', tags: ['t-sql', 'query', 'running-totals'],
  q: r`Write running totals, a 7-day moving average and an account balance "as of" any date. Why does the window frame matter?`,
  a: r`### Running total
{{SUM(Amount) OVER (PARTITION BY AccountId ORDER BY TxnDate, TxnId ROWS UNBOUNDED PRECEDING)}}. Always add a unique tiebreaker and an explicit **ROWS** frame.

### Why the frame matters
With an ORDER BY and no frame, SQL Server uses {{RANGE UNBOUNDED PRECEDING}}: rows with the same ORDER BY value are **peers** and get the same total, and the RANGE frame uses an on-disk spool in row mode, which is much slower. {{ROWS}} gives a true row-by-row running total and an in-memory spool.

### Moving average
Calendar-correct 7-day averages need one row per day: if days can be missing, join to a calendar table first, otherwise {{ROWS BETWEEN 6 PRECEDING AND CURRENT ROW}} averages the last 7 **rows**, not 7 days.

### Balance as of a date
Either the running total filtered at the date, or simply {{SUM ... WHERE TxnDate <= @asOf}} with an index on {{(AccountId, TxnDate) INCLUDE (Amount)}}. For large ledgers, keep daily snapshot balances and add only the transactions since the last snapshot.

### Old-version alternatives
Before 2012: correlated subqueries (O(n²)) or the "quirky update" (undocumented ordering, unsafe). Mention them only to explain why window functions replaced them.`,
  code: r`~~~sql
-- Running balance per account
SELECT AccountId, TxnId, TxnDate, Amount,
       SUM(Amount) OVER (PARTITION BY AccountId ORDER BY TxnDate, TxnId ROWS UNBOUNDED PRECEDING) AS RunningBalance
FROM dbo.Transactions;

-- 7-day moving average of daily revenue, calendar-correct (dbo.Calendar has one row per date)
WITH daily AS (
  SELECT c.d, COALESCE(SUM(o.Total), 0) AS Revenue
  FROM dbo.Calendar c LEFT JOIN dbo.Orders o ON o.OrderDate >= c.d AND o.OrderDate < DATEADD(day, 1, c.d)
  WHERE c.d BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY c.d)
SELECT d, Revenue, AVG(Revenue) OVER (ORDER BY d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS Avg7d
FROM daily;

-- Balance as of a date
DECLARE @asOf date = '2026-06-30';
SELECT AccountId, SUM(Amount) AS BalanceAsOf
FROM dbo.Transactions WHERE TxnDate <= @asOf GROUP BY AccountId;

-- Percentage of total and cumulative percentage
SELECT ProductId, Revenue,
       100.0 * Revenue / SUM(Revenue) OVER () AS PctOfTotal,
       100.0 * SUM(Revenue) OVER (ORDER BY Revenue DESC, ProductId ROWS UNBOUNDED PRECEDING) / SUM(Revenue) OVER () AS CumPct
FROM dbo.ProductRevenue;
~~~`,
  pts: [r`SUM() OVER (... ROWS UNBOUNDED PRECEDING) is the running total.`, r`Default RANGE frame treats ties as peers and is slower; specify ROWS.`, r`Add a unique tiebreaker to ORDER BY.`, r`Moving averages over days need a calendar table when days can be missing.`, r`For large ledgers, snapshot balances plus recent transactions.`],
  ex: r`A statement generator switched from a correlated subquery (O(n²), 14 minutes) to a windowed running total with ROWS (11 seconds) for 40 million transactions.`,
  fu: [r`How do you reset the running total at each month?`, r`What does batch mode on rowstore do for window aggregates?`],
  pit: [r`Relying on the default RANGE frame and getting identical totals for same-day rows.`, r`Averaging 7 rows and calling it 7 days.`] },

{ id: 'q27', level: 'Senior', tags: ['t-sql', 'query', 'recursive-cte'],
  q: r`Use a recursive CTE to return an employee's full reporting line and everyone under a manager, with depth and path. How do you guard against cycles?`,
  a: r`A recursive CTE has an **anchor** member (the starting rows) and a **recursive** member that joins the CTE to the table, combined with {{UNION ALL}}. Each iteration adds the next level until no rows are produced.

### Down the tree (all reports of a manager)
Anchor: the manager. Recursive: employees whose ManagerId is in the previous level. Carry {{Depth + 1}} and a path string for ordering and display.

### Up the tree (management chain)
Anchor: the employee. Recursive: join to the manager of the previous row.

### Cycles and limits
Bad data (A manages B, B manages A) causes infinite recursion until {{MAXRECURSION}} (default 100) aborts with an error. Guard by carrying the path and stopping when the next id is already in it, and set {{OPTION (MAXRECURSION n)}} deliberately ({{0}} = unlimited, risky).

### Alternatives
For deep, read-heavy hierarchies consider {{hierarchyid}} (fast subtree queries via {{IsDescendantOf}}), a closure table (all ancestor/descendant pairs), or the SQL graph tables. Recursive CTEs are fine for hundreds of thousands of nodes with an index on ManagerId.`,
  code: r`~~~sql
-- Everyone under manager 10, with depth and path
WITH org AS (
  SELECT EmployeeId, Name, ManagerId, 0 AS Depth,
         CAST('/' + CAST(EmployeeId AS varchar(10)) + '/' AS varchar(4000)) AS Path
  FROM dbo.Employees WHERE EmployeeId = 10
  UNION ALL
  SELECT e.EmployeeId, e.Name, e.ManagerId, o.Depth + 1,
         CAST(o.Path + CAST(e.EmployeeId AS varchar(10)) + '/' AS varchar(4000))
  FROM dbo.Employees e
  JOIN org o ON e.ManagerId = o.EmployeeId
  WHERE o.Path NOT LIKE '%/' + CAST(e.EmployeeId AS varchar(10)) + '/%'   -- cycle guard
)
SELECT REPLICATE('    ', Depth) + Name AS OrgChart, Depth, Path
FROM org ORDER BY Path
OPTION (MAXRECURSION 50);

-- Management chain upwards for employee 457
WITH chain AS (
  SELECT EmployeeId, Name, ManagerId, 0 AS Lvl FROM dbo.Employees WHERE EmployeeId = 457
  UNION ALL
  SELECT m.EmployeeId, m.Name, m.ManagerId, c.Lvl + 1
  FROM dbo.Employees m JOIN chain c ON m.EmployeeId = c.ManagerId)
SELECT * FROM chain ORDER BY Lvl;

CREATE INDEX IX_Employees_Manager ON dbo.Employees (ManagerId) INCLUDE (Name);
~~~`,
  pts: [r`Anchor member plus recursive member joined with UNION ALL.`, r`Carry Depth and a Path column for ordering and display.`, r`Guard cycles by checking the path, and set MAXRECURSION deliberately.`, r`Index ManagerId so each level is a seek.`, r`For heavy subtree reads consider hierarchyid or a closure table.`],
  ex: r`An approval-routing service built the approval chain with a recursive CTE; a data-entry error created a cycle and hit MAXRECURSION in production until a path-based guard and a CHECK in the HR import were added.`,
  fu: [r`Count the total headcount under each manager.`, r`Bill of materials: total quantity of each component in a product.`],
  pit: [r`UNION instead of UNION ALL (extra distinct sort, may hide cycle symptoms).`, r`No cycle protection on user-maintained data.`] },

{ id: 'q28', level: 'Senior', tags: ['batch'],
  q: r`How do you update or delete hundreds of millions of rows safely?`,
  a: r`Never in one statement: it would hold locks for hours, escalate to a table lock, fill the transaction log (it cannot truncate until commit), lag AG replicas, and take forever to roll back if cancelled.

Batch it:

~~~sql
DECLARE @rows int = 1;
WHILE @rows > 0
BEGIN
  DELETE TOP (5000) FROM dbo.AuditLog WHERE CreatedAt < @cutoff;   -- index on CreatedAt
  SET @rows = @@ROWCOUNT;
  WAITFOR DELAY '00:00:00.200';  -- throttle; let log backups and replicas keep up
END
~~~

Also: keep each batch under the lock escalation threshold, drive by an indexed key range for stable performance, checkpoint progress for restartability, run off-peak, monitor log usage and replica lag, and consider **partition SWITCH/TRUNCATE** or "copy the rows you keep into a new table then swap" when removing most of a table.`,
  pts: [r`Batch under escalation threshold`, r`Throttle for log and replicas`, r`Restartable progress`, r`Partition switch or copy-and-swap for most rows`],
  ex: r`Purging 600 million audit rows ran in batches over two nights with no user impact.`,
  fu: [r`Why can cancelling a huge delete take longer than running it?`],
  pit: [r`A single DELETE with no WHERE index support.`] },

{ id: 'q29', level: 'Senior', tags: ['upsert', 'concurrency'],
  q: r`How do you implement an idempotent upsert in SQL Server under concurrency? What is wrong with MERGE or IF EXISTS?`,
  a: r`{{IF NOT EXISTS (SELECT ...) INSERT ... ELSE UPDATE ...}} is a race: two sessions both see "not exists" and both insert (duplicate rows, or a unique-key error). {{MERGE}} has the same race at default isolation **and** a history of bugs and surprising behaviour (filtered indexes, triggers, multiple matches); many teams avoid it for OLTP upserts.

Safe patterns:

~~~sql
-- 1. Update first, insert if nothing updated, serialised on the key range
BEGIN TRAN;
UPDATE dbo.Positions WITH (UPDLOCK, SERIALIZABLE) SET Qty = @qty, UpdatedUtc = SYSUTCDATETIME()
WHERE AccountId = @a AND Symbol = @s;
IF @@ROWCOUNT = 0
  INSERT dbo.Positions (AccountId, Symbol, Qty, UpdatedUtc) VALUES (@a, @s, @qty, SYSUTCDATETIME());
COMMIT;

-- 2. Insert and treat a duplicate-key error (2627/2601) as "exists", then update
~~~

The **unique constraint** on the natural key is the real guarantee; the locking hints prevent the error from happening. {{SERIALIZABLE}} here takes a key-range lock only on that key (with a supporting index), so contention stays local.

For bulk upserts: load into a staging table, then set-based UPDATE + INSERT ... WHERE NOT EXISTS in one transaction with appropriate locks, or {{MERGE}} with {{HOLDLOCK}} if the team accepts it and tests it.`,
  pts: [r`IF EXISTS then INSERT is a race`, r`MERGE needs HOLDLOCK and has known issues`, r`UPDLOCK + SERIALIZABLE on the key`, r`Unique constraint as the true guarantee`],
  ex: r`A position-keeping service produced duplicate rows under parallel trade imports until the upsert used UPDLOCK/SERIALIZABLE and a unique index on (AccountId, Symbol).`,
  fu: [r`Why does SERIALIZABLE not lock the whole table here?`, r`How does PostgreSQL ON CONFLICT compare?`],
  pit: [r`Relying on application-side "check then insert".`, r`MERGE without HOLDLOCK in concurrent code.`] },

{ id: 'q30', level: 'Senior', tags: ['cursors', 'set-based', 'programmability'],
  q: r`Cursors: what types exist, why are they slow, when are they genuinely the right tool, and how do you rewrite a cursor-based FIFO payment allocation as set-based SQL?`,
  a: r`### Cursor options
| Option | Meaning |
|---|---|
| {{LOCAL}} / {{GLOBAL}} | scope; **GLOBAL is the default**, so cursors leak across batches on the connection |
| {{FORWARD_ONLY}} / {{SCROLL}} | fetch direction |
| {{STATIC}} | copies the result into tempdb at OPEN; does not see changes |
| {{KEYSET}} | copies keys into tempdb; sees updates, not inserts |
| {{DYNAMIC}} | sees all changes; re-evaluated on each fetch |
| {{FAST_FORWARD}} | forward-only, read-only, optimised: the right default |
| {{READ_ONLY}}, {{SCROLL_LOCKS}}, {{OPTIMISTIC}} | concurrency |

Rule: if you must use one, declare it {{LOCAL FAST_FORWARD}} (or {{LOCAL STATIC READ_ONLY FORWARD_ONLY}}), always {{CLOSE}} and {{DEALLOCATE}}, and loop on {{@@FETCH_STATUS = 0}}.

### Why they are slow
Row-by-row ("RBAR"): every iteration is a separate statement with its own execution, locks, log record and round trip inside the engine. A set-based statement does the same work as one plan that can use hash joins, batch mode and parallelism. A **WHILE loop with SELECT TOP (1)** is the same anti-pattern and often worse, because each iteration re-seeks.

### When a loop is right
- **Batching on purpose**: deleting 500 million rows in chunks of 5,000 (the loop is over batches, not rows).
- **Per-object administration**: looping over databases, tables or indexes to run DDL, index maintenance, or {{DBCC}}.
- **Calling something that only takes one row** and cannot be changed: a legacy procedure, an external call via a queue.
- **Truly sequential state** that no window function can express, and the volume is small.

### The FIFO allocation rewrite
Allocate payments to a customer's invoices oldest first. Cursor version: nested loop over payments and invoices, updating remaining balances, minutes for a large book. Set-based version: compute **cumulative ranges** with running totals, then the amount allocated from a payment to an invoice is the **overlap of the two ranges**: {{LEAST(invEnd, payEnd) - GREATEST(invStart, payStart)}} where positive. One query, one plan.`,
  code: r`~~~sql
-- Acceptable loop: per-database maintenance, cursor declared correctly
DECLARE @db sysname, @sql nvarchar(max);
DECLARE dbs CURSOR LOCAL FAST_FORWARD FOR
  SELECT name FROM sys.databases WHERE database_id > 4 AND state_desc = 'ONLINE';
OPEN dbs;
FETCH NEXT FROM dbs INTO @db;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @sql = N'USE ' + QUOTENAME(@db) + N'; EXEC sys.sp_updatestats;';
  EXEC sys.sp_executesql @sql;
  FETCH NEXT FROM dbs INTO @db;
END;
CLOSE dbs; DEALLOCATE dbs;

-- Set-based FIFO allocation of payments to invoices (2022 GREATEST/LEAST)
WITH inv AS (
  SELECT CustomerId, InvoiceId, Amount,
         SUM(Amount) OVER (PARTITION BY CustomerId ORDER BY DueDate, InvoiceId ROWS UNBOUNDED PRECEDING) - Amount AS s,
         SUM(Amount) OVER (PARTITION BY CustomerId ORDER BY DueDate, InvoiceId ROWS UNBOUNDED PRECEDING)          AS e
  FROM dbo.Invoices WHERE Status = 'Open'),
pay AS (
  SELECT CustomerId, PaymentId, Amount,
         SUM(Amount) OVER (PARTITION BY CustomerId ORDER BY ReceivedUtc, PaymentId ROWS UNBOUNDED PRECEDING) - Amount AS s,
         SUM(Amount) OVER (PARTITION BY CustomerId ORDER BY ReceivedUtc, PaymentId ROWS UNBOUNDED PRECEDING)          AS e
  FROM dbo.Payments WHERE Status = 'Unallocated')
INSERT dbo.Allocations (PaymentId, InvoiceId, Amount)
SELECT p.PaymentId, i.InvoiceId, LEAST(i.e, p.e) - GREATEST(i.s, p.s)
FROM inv i JOIN pay p ON p.CustomerId = i.CustomerId
 AND p.s < i.e AND i.s < p.e;                                 -- ranges overlap

-- The anti-pattern: a WHILE loop is still row-by-row
-- WHILE EXISTS (SELECT 1 FROM #todo) BEGIN SELECT TOP (1) @id = Id FROM #todo; ... DELETE #todo WHERE Id = @id; END
~~~`,
  pts: [r`Cursors default to GLOBAL; declare LOCAL FAST_FORWARD, then CLOSE and DEALLOCATE.`, r`Row-by-row means one execution per row; a WHILE + TOP (1) loop is no better.`, r`Legitimate loops: batching, per-object admin, single-row legacy calls, small truly sequential logic.`, r`Running totals plus range overlap turn FIFO allocation into one set-based query.`, r`Measure: set-based rewrites are commonly 10 to 1,000 times faster.`],
  ex: r`A receivables system allocated 1.4 million payments a month with a nested cursor that ran for 3 hours and blocked collections staff. The running-total overlap rewrite ran in 70 seconds, and because it was one statement it was also atomic: no half-allocated customers after a failure.`,
  fu: [r`How would you do the FIFO allocation before SQL Server 2022 without GREATEST and LEAST?`, r`What is the difference between a STATIC and a KEYSET cursor in tempdb usage?`, r`How would you batch a large update without a cursor?`],
  pit: [r`Default (GLOBAL, dynamic, updatable) cursors in production code.`, r`Replacing a cursor with a WHILE loop and calling it set-based.`, r`Forgetting DEALLOCATE, leaking cursors on pooled connections.`],
  tip: r`Show one legitimate cursor and one rewrite. "Never use cursors" is a junior answer; knowing exactly when they fit is the senior one.` },

{ id: 'q31', level: 'Senior', tags: ['triggers', 'programmability', 'audit'],
  q: r`Triggers: AFTER vs INSTEAD OF vs DDL vs logon, the inserted and deleted tables, and the classic bugs. When would you allow a trigger in a system you lead?`,
  a: r`### Kinds
- **AFTER (FOR) DML trigger**: runs after the statement's changes and constraint checks, **inside the same transaction**. An error or {{ROLLBACK}} in it undoes the caller's statement (and aborts the batch).
- **INSTEAD OF trigger**: replaces the action; mainly to make complex **views** updatable or to redirect writes during a migration.
- **DDL trigger** (database or server scope): fires on {{CREATE}}, {{ALTER}}, {{DROP}}; {{EVENTDATA()}} returns XML describing the event. Used for schema-change audit and to block changes outside the pipeline.
- **Logon trigger**: runs at login; can deny connections. A bug here locks **everyone** out (recover through the Dedicated Admin Connection).

### inserted and deleted
Pseudo-tables with the rows after and before the change: INSERT fills inserted, DELETE fills deleted, UPDATE fills both. A trigger fires **once per statement**, so they can hold 0, 1 or 1 million rows.

### Classic bugs
1. **Single-row assumption**: {{SELECT @id = Id FROM inserted}} silently processes one arbitrary row of a multi-row update.
2. No early exit: {{IF @@ROWCOUNT = 0 RETURN;}} (must be the first statement) avoids work when nothing changed.
3. {{UPDATE(col)}} and {{COLUMNS_UPDATED()}} say the column was in the SET list, **not** that the value changed; compare inserted and deleted.
4. Missing {{SET NOCOUNT ON}}: extra "rows affected" messages confuse clients and ORMs.
5. **OUTPUT clause conflict**: {{OUTPUT}} without {{INTO}} fails on a table with enabled triggers. EF Core 7+ uses OUTPUT for inserts and updates, so declare the trigger ({{tb.HasTrigger("...")}}) or EF fails at runtime.
6. Nested triggers (up to 32 levels) and the {{RECURSIVE_TRIGGERS}} database option cause surprise cascades.
7. Not fired by {{TRUNCATE}} or by bulk loads unless {{FIRE_TRIGGERS}} is specified, so the audit trail has holes.

### Cost
The trigger's work adds to every write's latency and lock duration, and is invisible to the developer reading the application code.

### When I allow them
- Audit or history only when **temporal tables** or **CDC** do not fit.
- Enforcing a cross-row or cross-table invariant that constraints cannot express, where a bypass would be a financial incident.
- DDL triggers for change governance.
- **INSTEAD OF** on a view during a table split or rename migration.

Never for business workflows (sending emails, calling services, cascading business rules): put those in the application or an outbox.`,
  code: r`~~~sql
-- Correct multi-row audit trigger: compares old and new values, set-based
CREATE OR ALTER TRIGGER dbo.trg_Accounts_LimitAudit ON dbo.Accounts
AFTER UPDATE AS
BEGIN
  IF @@ROWCOUNT = 0 RETURN;
  SET NOCOUNT ON;
  IF NOT UPDATE(CreditLimit) RETURN;                       -- cheap filter only
  INSERT dbo.AccountLimitAudit (AccountId, OldLimit, NewLimit, ChangedBy, ChangedUtc)
  SELECT i.AccountId, d.CreditLimit, i.CreditLimit, ORIGINAL_LOGIN(), SYSUTCDATETIME()
  FROM inserted i JOIN deleted d ON d.AccountId = i.AccountId
  WHERE i.CreditLimit IS DISTINCT FROM d.CreditLimit;      -- value actually changed
END;
GO
-- Invariant no constraint can express: a ledger journal must balance
CREATE OR ALTER TRIGGER dbo.trg_Postings_Balanced ON dbo.Postings
AFTER INSERT, UPDATE, DELETE AS
BEGIN
  IF @@ROWCOUNT = 0 RETURN;
  SET NOCOUNT ON;
  IF EXISTS (SELECT p.JournalId FROM dbo.Postings p
             WHERE p.JournalId IN (SELECT JournalId FROM inserted UNION SELECT JournalId FROM deleted)
             GROUP BY p.JournalId HAVING SUM(p.Amount) <> 0)
    THROW 51000, 'Journal does not balance', 1;           -- rolls back the caller's statement
END;
GO
-- DDL trigger: record every schema change and who made it
CREATE OR ALTER TRIGGER ddl_AuditSchema ON DATABASE FOR DDL_DATABASE_LEVEL_EVENTS AS
  INSERT dbo.SchemaChangeLog (EventXml, LoginName, ChangedUtc) VALUES (EVENTDATA(), ORIGINAL_LOGIN(), SYSUTCDATETIME());
~~~
~~~csharp
// EF Core 7+: tell EF the table has a trigger so it does not use OUTPUT without INTO
modelBuilder.Entity<Account>().ToTable(tb => tb.HasTrigger("trg_Accounts_LimitAudit"));
~~~`,
  pts: [r`AFTER runs inside the caller's transaction; INSTEAD OF replaces the action; DDL and logon triggers for governance.`, r`Fires once per statement: always join inserted and deleted set-based.`, r`UPDATE(col) means "in the SET list"; compare old and new values.`, r`OUTPUT without INTO fails with triggers; EF Core needs HasTrigger.`, r`Allow for audit, unexpressible invariants and DDL governance; never for workflows.`],
  ex: r`A limit-change trigger written as SELECT @id = AccountId FROM inserted audited one account per batch job; the regulator's sample found 11,000 unaudited limit changes. The set-based rewrite (and a test that updates 1,000 rows) closed the finding.`,
  fu: [r`How do you temporarily bypass a trigger for a data fix without disabling it for everyone?`, r`Why does a ROLLBACK inside a trigger raise error 3609 in the caller?`, r`How would you replace this audit trigger with a temporal table?`],
  pit: [r`Scalar variables assigned from inserted.`, r`Calling external services, sending mail or running long queries in a trigger.`, r`Bulk loads and TRUNCATE silently bypassing the audit trigger.`] },

{ id: 'q32', level: 'Senior', tags: ['views', 'indexed-views', 'programmability'],
  q: r`Views, indexed views and partitioned views: what does each really do at execution time, what are the indexed-view requirements and costs, and why are nested views a trap?`,
  a: r`### Ordinary views
A view is a stored SELECT. At compile time its text is **expanded inline** into the calling query, so it has no plan, no statistics and no performance effect of its own. Uses: a stable contract over changing tables, column and row security ({{GRANT SELECT}} on the view only), and hiding joins.

- {{WITH SCHEMABINDING}}: base tables cannot be altered in ways that break the view; required for indexed views and good practice for any view a team depends on.
- {{WITH CHECK OPTION}}: inserts and updates through the view must still satisfy its WHERE clause.
- Updatable if a statement touches only one base table; otherwise use an {{INSTEAD OF}} trigger.
- Non-schemabound views using {{SELECT *}} keep stale column metadata after a table change until {{sp_refreshview}} runs.

### Nested views
Views on views on views give the optimiser a 30-table query. It may hit its **optimisation timeout**, pick a poor plan, and still join tables the caller never needed. Join elimination only removes a join when a **trusted** foreign key or uniqueness proves it is safe ({{NOCHECK}} constraints are untrusted). Keep views one level deep over base tables.

### Indexed (materialised) views
A unique clustered index on a view **stores** its result and maintains it **synchronously** on every write to the base tables.
Requirements (the common ones): {{SCHEMABINDING}}; two-part names; deterministic expressions only; no outer joins, {{DISTINCT}}, subqueries, {{TOP}}, {{UNION}}, {{MIN}}/{{MAX}} or {{AVG}}; with {{GROUP BY}} you must include {{COUNT_BIG(*)}}; {{SUM}} over non-nullable expressions; required SET options ({{ANSI_NULLS}}, {{QUOTED_IDENTIFIER}} and others ON) for every session that writes the base tables.

Costs: each base-table write updates the aggregated row, so a view that sums per merchant turns **every payment into an update of the same row**, which becomes a hot spot and a deadlock source. Enterprise edition matches indexed views automatically; Standard edition needs {{WITH (NOEXPAND)}}, which is also recommended on Enterprise because it lets the view's statistics be used.

### Partitioned views
{{UNION ALL}} over identical tables, each with a {{CHECK}} constraint on the partitioning column (for example one table per year). The optimiser skips tables whose constraint excludes the predicate. Useful for archiving and for editions or designs where table partitioning does not fit, and it lets each member table have its own indexes and compression.`,
  code: r`~~~sql
-- Indexed view: daily totals per merchant, maintained on every insert
CREATE OR ALTER VIEW dbo.vMerchantDaily WITH SCHEMABINDING AS
SELECT p.MerchantId, p.ValueDate,
       SUM(p.Amount)  AS Total,          -- Amount is NOT NULL
       COUNT_BIG(*)   AS Cnt             -- mandatory with GROUP BY
FROM dbo.Payments p
GROUP BY p.MerchantId, p.ValueDate;
GO
CREATE UNIQUE CLUSTERED INDEX UCX_vMerchantDaily ON dbo.vMerchantDaily (MerchantId, ValueDate);
GO
SELECT Total, Cnt FROM dbo.vMerchantDaily WITH (NOEXPAND) WHERE MerchantId = @m AND ValueDate = @d;

-- Security view with CHECK OPTION: support staff see and edit only their region
CREATE OR ALTER VIEW support.vCustomersEmea WITH SCHEMABINDING AS
SELECT CustomerId, Name, Region, Status FROM dbo.Customers WHERE Region = 'EMEA'
WITH CHECK OPTION;
GO
-- Partitioned view for archive years
CREATE OR ALTER VIEW dbo.vTrades AS
SELECT * FROM dbo.Trades2025 UNION ALL SELECT * FROM dbo.Trades2026;
-- each member: CHECK (TradeDate >= '2026-01-01' AND TradeDate < '2027-01-01'), so plans skip the other year

-- Check for untrusted foreign keys that block join elimination
SELECT name, is_not_trusted FROM sys.foreign_keys WHERE is_not_trusted = 1;
~~~`,
  pts: [r`Ordinary views are expanded inline: abstraction and security, not speed.`, r`Nested views cause optimiser timeouts and redundant joins; join elimination needs trusted keys.`, r`Indexed views: SCHEMABINDING, COUNT_BIG(*), deterministic, no outer joins or MIN/MAX.`, r`Indexed views are maintained synchronously: aggregated rows become write hot spots.`, r`Use NOEXPAND; partitioned views use CHECK constraints for elimination.`],
  ex: r`A dashboard indexed view summing card spend per merchant made Black Friday checkout deadlock: thousands of payments per second updated the same aggregated row for the biggest merchants. The fix was to drop the indexed view, aggregate every minute into a summary table, and serve the dashboard from that.`,
  fu: [r`Why must every session writing the base table have specific SET options when an indexed view exists?`, r`How does an indexed view compare with a columnstore index for reporting?`, r`How would you use a view to rename a table with zero downtime?`],
  pit: [r`Creating indexed views on hot OLTP tables without measuring write cost.`, r`Views four levels deep that each join the same tables.`, r`SELECT * in views and forgetting sp_refreshview.`],
  trade: r`Indexed views give instant aggregates at the price of slower, more contended writes. Prefer them for read-heavy tables with low write concurrency per aggregated key; otherwise use periodic summary tables or columnstore.` },

{ id: 'q33', level: 'Senior', tags: ['dynamic-sql', 'security', 'pivot', 'performance'],
  q: r`Dynamic SQL done properly: EXEC vs sp_executesql, QUOTENAME, the catch-all search procedure, dynamic PIVOT, plan cache impact and permissions.`,
  a: r`### EXEC vs sp_executesql
{{EXEC(@sql)}} runs a string with no parameters: values must be concatenated, so it is **injectable** and each distinct value compiles a new plan. {{sp_executesql @sql, N'@p int', @p = @v}} takes typed parameters: values never become code and the plan is reused. It also supports {{OUTPUT}} parameters.

### Identifiers vs values
- **Values** (customer id, date, search text) are always parameters.
- **Identifiers** (column, table, sort column) cannot be parameters. Validate them against an **allow-list** (or {{sys.columns}}) and wrap in {{QUOTENAME()}}, which brackets and escapes {{]}}. QUOTENAME returns NULL for input over 128 characters, so a NULL statement is a sign of abuse.

### The catch-all search procedure
{{WHERE (@Name IS NULL OR Name = @Name) AND (@Iban IS NULL OR Iban = @Iban) ...}} produces one plan for every combination of parameters, usually a scan. Two fixes:
1. {{OPTION (RECOMPILE)}}: the optimiser embeds the current values and removes the irrelevant predicates. Simple; costs a compile per call. Fine for a few calls per second.
2. **Dynamic SQL that appends only the supplied predicates**, executed with sp_executesql: one cached plan per *shape* of search, each with seeks. Best for high call rates.

### Dynamic PIVOT
When the column list comes from data (regions, months, product names), build it with {{STRING_AGG(QUOTENAME(x), ',')}}, then run the PIVOT with sp_executesql; filter values still go in as parameters. Often better done in the reporting layer.

### Plan cache and operations
- Concatenated literals mean one plan per value: cache bloat. {{optimize for ad hoc workloads}} stores only a stub for the first execution.
- {{sys.dm_exec_describe_first_result_set}} returns the result shape for testing; {{PRINT}} the statement in debug mode.

### Permissions
Dynamic SQL **breaks ownership chaining**: it runs with the *caller's* permissions, so a user with only EXECUTE on the procedure gets "SELECT permission denied". Fix with **module signing** (a certificate user with the required rights) rather than {{EXECUTE AS OWNER}}, which grants everything the owner has (often dbo).`,
  code: r`~~~sql
CREATE OR ALTER PROCEDURE dbo.Customers_Search
  @Name nvarchar(100) = NULL, @Iban varchar(34) = NULL, @CreatedFrom date = NULL,
  @SortBy sysname = N'CreatedUtc', @Desc bit = 1, @Debug bit = 0
AS
BEGIN
  SET NOCOUNT ON;
  IF @SortBy NOT IN (N'CreatedUtc', N'Name', N'CustomerId') THROW 50010, 'Invalid sort column', 1;  -- allow-list

  DECLARE @sql nvarchar(max) = N'SELECT TOP (200) CustomerId, Name, Iban, CreatedUtc FROM dbo.Customers WHERE 1 = 1';
  IF @Name IS NOT NULL        SET @sql += N' AND Name LIKE @Name + N''%''';
  IF @Iban IS NOT NULL        SET @sql += N' AND Iban = @Iban';
  IF @CreatedFrom IS NOT NULL SET @sql += N' AND CreatedUtc >= @CreatedFrom';
  SET @sql += N' ORDER BY ' + QUOTENAME(@SortBy) + CASE WHEN @Desc = 1 THEN N' DESC' ELSE N' ASC' END + N';';

  IF @Debug = 1 PRINT @sql;
  EXEC sys.sp_executesql @sql,
       N'@Name nvarchar(100), @Iban varchar(34), @CreatedFrom date',
       @Name = @Name, @Iban = @Iban, @CreatedFrom = @CreatedFrom;   -- unused parameters are fine
END;
GO
-- Dynamic PIVOT: one column per region present in the data
DECLARE @cols nvarchar(max), @sql nvarchar(max), @from date = '2026-01-01', @to date = '2027-01-01';
SELECT @cols = STRING_AGG(QUOTENAME(Region), ',') WITHIN GROUP (ORDER BY Region)
FROM (SELECT DISTINCT Region FROM dbo.Sales) r;
SET @sql = N'SELECT ProductId, ' + @cols + N'
FROM (SELECT ProductId, Region, Amount FROM dbo.Sales WHERE SaleDate >= @from AND SaleDate < @to) s
PIVOT (SUM(Amount) FOR Region IN (' + @cols + N')) p;';
EXEC sys.sp_executesql @sql, N'@from date, @to date', @from = @from, @to = @to;

-- Module signing instead of EXECUTE AS OWNER
CREATE CERTIFICATE SearchCert ENCRYPTION BY PASSWORD = '<strong password>' WITH SUBJECT = 'Customers_Search';
CREATE USER SearchCertUser FROM CERTIFICATE SearchCert;
GRANT SELECT ON dbo.Customers TO SearchCertUser;
ADD SIGNATURE TO dbo.Customers_Search BY CERTIFICATE SearchCert WITH PASSWORD = '<strong password>';
~~~`,
  pts: [r`sp_executesql with typed parameters; never concatenate values.`, r`Identifiers: allow-list plus QUOTENAME.`, r`Catch-all search: OPTION (RECOMPILE) for low volume, predicate-building dynamic SQL for high volume.`, r`Dynamic PIVOT: STRING_AGG(QUOTENAME(...)) for columns, parameters for values.`, r`Dynamic SQL breaks ownership chaining; prefer module signing to EXECUTE AS OWNER.`],
  ex: r`A customer-search screen with nine optional filters timed out at peak because its single catch-all plan scanned 60 million rows. Rewriting it with predicate-building sp_executesql produced 14 cached plan shapes, all seeks, and p95 fell from 6 s to 25 ms.`,
  fu: [r`How do you test a dynamic SQL procedure for injection?`, r`Why does an ORDER BY column passed as a parameter not work, and what does CASE in ORDER BY do to the plan?`, r`What is the risk of EXECUTE AS OWNER when the owner is dbo?`],
  pit: [r`EXEC('... WHERE Name = ''' + @Name + '''').`, r`QUOTENAME around values (it is for identifiers).`, r`Granting table SELECT to every app user to "fix" dynamic SQL permission errors.`] },

{ id: 'q34', level: 'Senior', tags: ['functions', 'json'],
  q: r`JSON in SQL Server: OPENJSON, JSON_VALUE vs JSON_QUERY, JSON_MODIFY, FOR JSON, ISJSON and the 2022/2025 additions. How do you index JSON, and when should JSON not be in the database at all?`,
  a: r`### Reading
| Function | Returns | Note |
|---|---|---|
| {{JSON_VALUE(doc, '$.path')}} | a **scalar** as nvarchar(4000) | NULL for objects and arrays in lax mode; {{'strict $.path'}} raises an error instead |
| {{JSON_QUERY(doc, '$.path')}} | an **object or array** fragment | use it to keep nested JSON as JSON when re-emitting |
| {{OPENJSON(doc)}} | key, value, type rows | discovery |
| {{OPENJSON(doc) WITH (col type '$.path', ...)}} | typed rowset | the main shredding tool; {{AS JSON}} keeps a nested array for a second {{CROSS APPLY OPENJSON}} |
| {{ISJSON(doc)}} | 1 or 0 | use in a {{CHECK}} constraint; 2022 adds a type argument |
| {{JSON_PATH_EXISTS}} (2022) | 1 or 0 | test for optional properties |

### Writing
- {{FOR JSON PATH}} shapes query results with dotted aliases ({{AS [customer.name]}}); {{FOR JSON AUTO}} nests by join order; {{WITHOUT_ARRAY_WRAPPER}} and {{INCLUDE_NULL_VALUES}} control output.
- {{JSON_MODIFY(doc, '$.path', value)}} updates one property and returns the whole new document.
- {{JSON_OBJECT}} and {{JSON_ARRAY}} (2022) build JSON inline. Azure SQL and SQL Server 2025 add {{JSON_OBJECTAGG}}, {{JSON_ARRAYAGG}} and a native **json** data type (binary storage, faster than parsing nvarchar).

### Indexing
JSON stored as nvarchar(max) cannot be indexed directly. Add a **computed column** on {{JSON_VALUE}} (persisted or not) and index it; the optimiser matches queries that use the same expression. For frequent filters on many properties, the property belongs in a real column.

### Where JSON fits
- Good: raw payloads kept for audit (payment gateway responses, ISO 20022 messages after parsing key fields), extensible attributes that are read whole, configuration, passing sets to procedures, building API responses in one round trip.
- Bad: anything you aggregate, join on, constrain or report on regularly; financial amounts and states. Those need typed columns with constraints. JSON hides schema drift and makes the database unable to enforce correctness.`,
  code: r`~~~sql
-- Keep the raw gateway response, promote what we query
CREATE TABLE dbo.GatewayResponses (
  ResponseId bigint IDENTITY PRIMARY KEY,
  PaymentId  bigint NOT NULL,
  Payload    nvarchar(max) NOT NULL CONSTRAINT CK_Payload_IsJson CHECK (ISJSON(Payload) = 1),
  AuthCode   AS CAST(JSON_VALUE(Payload, '$.authorisation.code') AS varchar(12)),
  ReceivedUtc datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());
CREATE INDEX IX_Gateway_AuthCode ON dbo.GatewayResponses (AuthCode);

-- Shred an order with nested lines (typed), one row per line
DECLARE @doc nvarchar(max) = N'{"orderId":981,"currency":"GBP","lines":[{"sku":"A1","qty":2,"price":9.5},{"sku":"B7","qty":1,"price":120}]}';
SELECT o.OrderId, o.Currency, l.Sku, l.Qty, l.Price
FROM OPENJSON(@doc) WITH (OrderId int '$.orderId', Currency char(3) '$.currency', Lines nvarchar(max) '$.lines' AS JSON) o
CROSS APPLY OPENJSON(o.Lines) WITH (Sku varchar(20) '$.sku', Qty int '$.qty', Price decimal(19,4) '$.price') l;

-- Scalar vs fragment
SELECT JSON_VALUE(@doc, '$.currency') AS Ccy,       -- GBP
       JSON_VALUE(@doc, '$.lines')    AS NullInLax, -- NULL: not a scalar
       JSON_QUERY(@doc, '$.lines')    AS LinesJson; -- the array

-- Update one property
UPDATE dbo.CustomerPrefs SET Prefs = JSON_MODIFY(Prefs, '$.notifications.sms', CAST(0 AS bit)) WHERE CustomerId = @id;

-- API response in one round trip: customer with nested accounts
SELECT c.CustomerId AS [id], c.Name AS [name],
       (SELECT a.AccountNo AS [number], a.Balance AS [balance] FROM dbo.Accounts a
        WHERE a.CustomerId = c.CustomerId FOR JSON PATH) AS [accounts]
FROM dbo.Customers c WHERE c.CustomerId = @id
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;

SELECT JSON_OBJECT('id': 42, 'ccy': 'EUR', 'tags': JSON_ARRAY('fx', 'spot')) AS Built;   -- 2022+
~~~`,
  pts: [r`JSON_VALUE for scalars, JSON_QUERY for objects and arrays; lax returns NULL, strict errors.`, r`OPENJSON WITH gives typed rows; AS JSON plus CROSS APPLY for nested arrays.`, r`ISJSON in a CHECK constraint; JSON_MODIFY for single-property updates.`, r`Index via a computed column on JSON_VALUE.`, r`JSON for payloads and extensible attributes; never for amounts, states or anything you join on.`],
  ex: r`A card platform stored every scheme response as JSON and queried JSON_VALUE(Payload, '$.authorisation.code') during disputes, which scanned 900 million rows. A computed column plus index made dispute lookups 3 ms, while keeping the full payload for evidence.`,
  fu: [r`How does SQL Server 2025's native json type change storage and performance?`, r`When would you use a TVP rather than a JSON parameter?`, r`How do you handle a JSON property that is sometimes a number and sometimes a string?`],
  pit: [r`Filtering on JSON_VALUE without a computed-column index.`, r`Expecting JSON_VALUE to return an array.`, r`Storing balances or statuses only inside JSON.`] },

{ id: 'q35', level: 'Senior', tags: ['functions', 'aggregates', 'analytic-functions', 'reporting'],
  q: r`Aggregate and analytic functions for reporting: GROUPING SETS/ROLLUP/CUBE with GROUPING_ID, LAG/LEAD, FIRST_VALUE/LAST_VALUE, PERCENTILE_CONT, APPROX functions. Build month-over-month, year-over-year and median per region.`,
  a: r`### Aggregates worth knowing
{{COUNT}} vs {{COUNT_BIG}} (bigint, required in indexed views), {{COUNT(DISTINCT x)}}, {{SUM}}/{{AVG}} (**AVG of int returns int**), {{MIN}}/{{MAX}}, {{STDEV}}/{{STDEVP}}/{{VAR}}, {{STRING_AGG}}, {{CHECKSUM_AGG}} (cheap change detection, collision-prone), and for big tables {{APPROX_COUNT_DISTINCT}} (2019) and {{APPROX_PERCENTILE_CONT}}/{{DISC}} (2022): about 2% error for a fraction of the memory.

### Subtotals in one pass
{{GROUP BY GROUPING SETS ((Region, Product), (Region), ())}} returns detail, region subtotals and a grand total in one scan. {{ROLLUP(a, b)}} is the hierarchical shorthand, {{CUBE}} every combination. Subtotal rows show NULL in the rolled-up column, which is ambiguous when the data itself has NULLs, so label them with {{GROUPING(col)}} or {{GROUPING_ID(a, b)}} (a bitmask).

### Analytic (window) functions
- {{LAG(x, n, default)}} / {{LEAD}}: previous and next rows, for deltas and gaps.
- {{FIRST_VALUE}} / {{LAST_VALUE}}: beware the default frame {{RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW}}, which makes LAST_VALUE return the **current** row. Specify {{ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING}}.
- 2022 adds {{IGNORE NULLS}} to these, which makes "carry the last known price forward" a one-liner, and the {{WINDOW}} clause to name a window once.
- {{PERCENTILE_CONT(0.5)}} interpolates (true median); {{PERCENTILE_DISC}} returns an existing value; both are window-only, so add DISTINCT or group afterwards. {{CUME_DIST}}, {{PERCENT_RANK}} for distributions.
- Always use {{ROWS}} frames for running totals: the default RANGE frame uses an on-disk spool and treats ties together.

### MoM and YoY
Aggregate to one row per month **first**, then {{LAG(Revenue)}} for month-over-month. For year-over-year, {{LAG(x, 12)}} is only correct if every month exists; joining on {{DATEADD(year, -1, Mth)}} is correct even with gaps. Guard division with {{NULLIF(prev, 0)}}.`,
  code: r`~~~sql
-- Detail, region subtotals and grand total, labelled
SELECT CASE WHEN GROUPING(Region) = 1 THEN 'ALL' ELSE Region END AS Region,
       CASE WHEN GROUPING(Product) = 1 THEN 'ALL' ELSE Product END AS Product,
       SUM(Amount) AS Revenue, GROUPING_ID(Region, Product) AS Lvl     -- 0 detail, 1 region, 3 total
FROM dbo.Sales WHERE SaleDate >= '2026-01-01' AND SaleDate < '2027-01-01'
GROUP BY GROUPING SETS ((Region, Product), (Region), ());

-- Month-over-month and year-over-year (gap-safe)
WITH monthly AS (
  SELECT DATETRUNC(month, OrderDate) AS Mth, SUM(Total) AS Revenue
  FROM dbo.Orders WHERE OrderDate >= '2024-01-01' AND OrderDate < '2026-11-01'
  GROUP BY DATETRUNC(month, OrderDate))
SELECT m.Mth, m.Revenue,
       100.0 * (m.Revenue - LAG(m.Revenue) OVER (ORDER BY m.Mth)) / NULLIF(LAG(m.Revenue) OVER (ORDER BY m.Mth), 0) AS MoMPct,
       100.0 * (m.Revenue - ly.Revenue) / NULLIF(ly.Revenue, 0) AS YoYPct
FROM monthly m LEFT JOIN monthly ly ON ly.Mth = DATEADD(year, -1, m.Mth)
ORDER BY m.Mth;

-- Median and P95 per region (exact) and approximate for a big dashboard
SELECT DISTINCT Region,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY Total) OVER (PARTITION BY Region) AS Median,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY Total) OVER (PARTITION BY Region) AS P95
FROM dbo.Orders;
SELECT Region, APPROX_PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY Total) AS ApproxMedian,
       APPROX_COUNT_DISTINCT(CustomerId) AS ApproxCustomers
FROM dbo.Orders GROUP BY Region;

-- Last known FX rate carried forward over missing days (2022 IGNORE NULLS, named window)
SELECT d.CalDate, d.Ccy,
       LAST_VALUE(r.Rate) IGNORE NULLS OVER w AS RateUsed
FROM dbo.CalendarCcy d LEFT JOIN dbo.FxRates r ON r.Ccy = d.Ccy AND r.RateDate = d.CalDate
WINDOW w AS (PARTITION BY d.Ccy ORDER BY d.CalDate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW);
~~~`,
  pts: [r`GROUPING SETS / ROLLUP / CUBE give subtotals in one scan; label with GROUPING or GROUPING_ID.`, r`LAST_VALUE needs an explicit ROWS frame; 2022 IGNORE NULLS carries values forward.`, r`PERCENTILE_CONT is the true median; APPROX_ functions for large dashboards.`, r`Aggregate per month first; LAG for MoM; DATEADD join for gap-safe YoY.`, r`AVG of int returns int; NULLIF for division.`],
  ex: r`A finance pack used LAG(Revenue, 12) for year-over-year; a new region with two months of no sales shifted every comparison by two months. The DATEADD join fixed it, and GROUPING SETS replaced three UNION ALL queries, cutting the pack's run time by two thirds.`,
  fu: [r`How would you compute a 3-month rolling average that ignores missing months?`, r`Why is AVG a poor measure of a typical order value?`, r`How accurate is APPROX_COUNT_DISTINCT and why is it cheaper?`],
  pit: [r`LAST_VALUE with the default frame.`, r`Confusing subtotal NULLs with real NULLs.`, r`LAG(12) when months can be missing.`] },

{ id: 'q36', level: 'Senior', tags: ['cdc', 'integration'],
  code: r`~~~sql
-- Temporal table: full row history for audit and "as of" queries
ALTER TABLE dbo.Accounts ADD
  ValidFrom datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL DEFAULT SYSUTCDATETIME(),
  ValidTo   datetime2(3) GENERATED ALWAYS AS ROW END HIDDEN NOT NULL DEFAULT '9999-12-31',
  PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo);
ALTER TABLE dbo.Accounts SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.AccountsHistory, HISTORY_RETENTION_PERIOD = 7 YEARS));
SELECT * FROM dbo.Accounts FOR SYSTEM_TIME AS OF '2026-09-30T23:59:59' WHERE AccountId = 42;
-- CDC for streaming changes out (Debezium reads cdc.* tables)
EXEC sys.sp_cdc_enable_table @source_schema = 'dbo', @source_name = 'Orders', @role_name = NULL;
~~~`,
  q: r`CDC, Change Tracking, temporal tables and triggers: which to use for change capture?`,
  a: r`| Mechanism | Captures | Use for |
|---|---|---|
| **Change Data Capture** | Full before/after column values, read asynchronously from the log | Feeding Kafka (Debezium), data warehouses, outbox-like integration |
| **Change Tracking** | Which rows changed (keys, version), not values | Lightweight sync of clients/caches |
| **Temporal tables** | Full row history with validity periods | Audit, "as of" queries, regulatory history |
| **Triggers** | Anything, synchronously | Small, carefully written cases; adds latency to every write |

CDC adds log-reading jobs and storage; ensure log truncation is not held up. Temporal tables give {{FOR SYSTEM_TIME AS OF}} queries with almost no code. For integration events prefer an explicit **outbox** table (business-level events) over raw CDC of internal tables, or use CDC on the outbox table.`,
  pts: [r`CDC = values from the log`, r`Change Tracking = what changed`, r`Temporal = history and as-of queries`, r`Outbox for business events`],
  ex: r`Regulators asked for the state of an account on a given date; a temporal table answered with one query.`,
  fu: [r`Why is CDC of internal tables a coupling risk?`],
  pit: [r`Business logic in triggers that nobody can see.`] },

{ id: 'q37', level: 'Principal', tags: ['scaling'],
  code: r`~~~csharp
// Reads to readable secondaries, writes to primary
var write = "Server=tcp:ag-listener,1433;Database=Shop;MultiSubnetFailover=True;Encrypt=True";
var read  = "Server=tcp:ag-listener,1433;Database=Shop;ApplicationIntent=ReadOnly;MultiSubnetFailover=True;Encrypt=True";
builder.Services.AddDbContext<ShopDb>(o => o.UseSqlServer(write));
builder.Services.AddDbContext<ShopReadDb>(o => o.UseSqlServer(read).UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));
~~~`,
  q: r`How do you scale SQL Server reads and writes?`,
  a: r`**Reads**: indexing and query fixes first; caching (Redis) for hot reads; **readable secondaries** in an AG (read-intent routing via {{ApplicationIntent=ReadOnly}}), with replica lag awareness; reporting moved to a warehouse/columnstore.

**Writes**: they go to a single primary, so scale **up** (CPU, memory, faster log storage), reduce write amplification (fewer indexes, narrow rows), batch, use in-memory OLTP for hot contention points, and fix last-page insert contention ({{OPTIMIZE_FOR_SEQUENTIAL_KEY}} in 2019+).

Beyond one primary: **shard** by tenant or key (application-level routing, elastic database tools), or split by domain (each service its own database). Sharding adds cross-shard query and rebalancing complexity; adopt only when single-node limits are real.`,
  pts: [r`Reads: indexes, cache, secondaries`, r`Writes: one primary, scale up and reduce amplification`, r`Shard by tenant only when needed`],
  ex: r`Routing reporting traffic to a readable secondary cut primary CPU by 35% without code changes beyond the connection string.`,
  fu: [r`What is last-page insert contention?`],
  pit: [r`Reading your own writes from an asynchronous secondary.`] },

{ id: 'q38', level: 'Principal', tags: ['auditing', 'compliance'],
  code: r`~~~sql
CREATE TABLE audit.Events (
  EventId bigint IDENTITY PRIMARY KEY, OccurredUtc datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
  Actor nvarchar(128) NOT NULL, Action varchar(64) NOT NULL, Entity varchar(64) NOT NULL, EntityId varchar(64) NOT NULL,
  Before nvarchar(max) NULL, After nvarchar(max) NULL, PrevHash binary(32) NULL, RowHash binary(32) NOT NULL);  -- hash chain
DENY UPDATE, DELETE ON audit.Events TO app_role;
-- SQL Server 2022 ledger tables: tamper-evident by the engine
CREATE TABLE dbo.LimitChanges (Id int PRIMARY KEY, AccountId int, NewLimit decimal(19,4)) WITH (LEDGER = ON (APPEND_ONLY = ON));
~~~`,
  q: r`How do you build an audit trail that satisfies regulators?`,
  a: r`Requirements: who changed what, when, from where, before and after values; tamper evidence; retention; searchable.

Options combined by need:

- **Temporal tables** for full row history with "as of" queries.
- **Application-level audit events** (business meaning: "fee waived by user X, reason Y") written in the same transaction as the change.
- **SQL Server Audit** for privileged and DDL activity, sent to a secured location.
- **Ledger tables** (SQL Server 2022 / Azure SQL): cryptographically chained history giving tamper evidence, with digests stored in immutable storage.

Controls: separate audit storage permissions from operators (segregation of duties), UTC timestamps, retention policies, and PII handling (erasure requests vs immutability: pseudonymise or crypto-shred personal fields).`,
  pts: [r`Business events + row history + DDL audit`, r`Ledger tables for tamper evidence`, r`Segregation of duties`, r`Erasure vs immutability plan`],
  ex: r`Ledger tables let a payments firm prove to auditors that settlement records were not altered after posting.`,
  fu: [r`How do you reconcile GDPR erasure with immutable ledgers?`],
  pit: [r`Audit tables writable by the same app login.`] },

{ id: 'q39', level: 'Principal', tags: ['ledger', 'design'],
  code: r`~~~sql
CREATE TABLE dbo.Journal (JournalId bigint IDENTITY PRIMARY KEY, IdempotencyKey varchar(64) NOT NULL UNIQUE, CreatedUtc datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());
CREATE TABLE dbo.Postings (JournalId bigint NOT NULL REFERENCES dbo.Journal, AccountId bigint NOT NULL, Amount decimal(19,4) NOT NULL,
  CONSTRAINT PK_Postings PRIMARY KEY (JournalId, AccountId));
CREATE OR ALTER PROCEDURE dbo.PostTransfer @Key varchar(64), @From bigint, @To bigint, @Amt decimal(19,4) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  BEGIN TRAN;
    INSERT dbo.Journal (IdempotencyKey) VALUES (@Key);                  -- duplicate retry fails here
    DECLARE @j bigint = SCOPE_IDENTITY();
    UPDATE dbo.Accounts SET Balance -= @Amt WHERE AccountId = @From AND Balance >= @Amt;   -- lock lower id first in real code
    IF @@ROWCOUNT = 0 THROW 50001, 'Insufficient funds', 1;
    UPDATE dbo.Accounts SET Balance += @Amt WHERE AccountId = @To;
    INSERT dbo.Postings VALUES (@j, @From, -@Amt), (@j, @To, @Amt);    -- sums to zero
  COMMIT;
END
~~~`,
  q: r`Design a double-entry ledger schema in SQL Server that is correct under concurrency.`,
  a: r`### Model
- {{Accounts(AccountId, Currency, Status, RowVersion)}}.
- {{JournalEntries(EntryId, IdempotencyKey UNIQUE, CreatedAt, Description)}}.
- {{Postings(PostingId, EntryId, AccountId, Amount decimal(19,4), Direction)}}: each entry's postings sum to zero (debits = credits), enforced in the posting procedure and checked by reconciliation.
- {{AccountBalances(AccountId, Balance, LastPostingId, RowVersion)}}: a maintained snapshot for fast reads; the postings table is the source of truth.

### Write path
One transaction: insert the entry (unique idempotency key stops duplicates), insert postings, update balances with **conditional updates** ({{WHERE Balance + @delta >= 0}} for no-overdraft accounts) and consistent account ordering (lowest id first) to avoid deadlocks.

### Integrity and audit
Append-only (no UPDATE/DELETE on postings: corrections are reversing entries), ledger tables or hash chaining for tamper evidence, daily reconciliation that balances sum to postings and entries sum to zero.`,
  pts: [r`Append-only postings, entries sum to zero`, r`Idempotency key unique`, r`Conditional balance updates in id order`, r`Reversals, not edits`],
  ex: r`~~~sql
UPDATE dbo.AccountBalances
SET Balance = Balance + @delta, LastPostingId = @postingId
WHERE AccountId = @acct AND (@allowNegative = 1 OR Balance + @delta >= 0);
IF @@ROWCOUNT = 0 THROW 50010, 'Insufficient funds or account locked', 1;
~~~`,
  fu: [r`How do you handle hot accounts (a merchant receiving thousands of postings per second)?`],
  pit: [r`Storing only a balance column and updating it in place.`] },

{ id: 'q40', level: 'Principal', tags: ['hot-spots', 'scaling'],
  code: r`~~~sql
-- Split the hot balance into N sub-balances; writers pick one, readers sum
CREATE TABLE dbo.MerchantBalanceSlots (MerchantId bigint NOT NULL, Slot tinyint NOT NULL, Balance decimal(19,4) NOT NULL,
  CONSTRAINT PK_MBS PRIMARY KEY (MerchantId, Slot));
UPDATE dbo.MerchantBalanceSlots SET Balance += @amt WHERE MerchantId = @m AND Slot = ABS(CHECKSUM(NEWID())) % 32;
SELECT SUM(Balance) FROM dbo.MerchantBalanceSlots WHERE MerchantId = @m;
-- Alternative: append-only postings + periodic aggregation (no row is updated by every request)
~~~`,
  q: r`A single "hot" row (merchant balance) is the throughput bottleneck. What are your options?`,
  a: r`Contention on one row serialises all writers. Options, by increasing complexity:

1. **Shorten the critical section**: only the balance update inside the transaction, nothing else; RCSI so readers do not block.
2. **Append-only postings without updating a balance row on every write**; compute balances asynchronously (or periodically), and check limits differently for accounts that receive funds (credits need no overdraft check).
3. **Sub-accounts / striping**: split the hot balance into N buckets (hash of posting id), sum on read; checks for debits run against the aggregate with care.
4. **Batching**: aggregate many small credits in memory/queue and post one entry per interval (accepting latency in visible balance).
5. **In-Memory OLTP** for the contention point.

Choose based on which invariants must be immediate (debits that can overdraw) versus eventually consistent (incoming credits).`,
  pts: [r`Know which invariants must be synchronous`, r`Append-only + async balance`, r`Striped buckets`, r`Batch credits`],
  ex: r`A marketplace's settlement account went from 300 to 8,000 postings per second by striping into 32 buckets for credits.`,
  fu: [r`How do you enforce a credit limit across striped buckets?`],
  pit: [r`Scaling up hardware for a single-row lock bottleneck.`] },

{ id: 'q41', level: 'Principal', tags: ['incident'],
  code: r`~~~csharp
// Typical causes: connection string to the old node instead of the listener, no MultiSubnetFailover,
// logins/SIDs or Agent jobs not present on the new primary, long DNS TTL on the listener
var cs = new SqlConnectionStringBuilder
{
    DataSource = "tcp:ag-listener.corp,1433", InitialCatalog = "Payments",
    MultiSubnetFailover = true, ConnectRetryCount = 3, ConnectRetryInterval = 5, Encrypt = SqlConnectionEncryptOption.Mandatory
}.ConnectionString;
~~~
~~~sql
-- Logins must exist with the same SIDs on every replica (or use contained users)
SELECT name, sid FROM sys.server_principals WHERE type IN ('S','U');
~~~`,
  q: r`Incident: the AG primary failed over and the application is down although the secondary is healthy. Why, and what do you change?`,
  a: r`Typical causes after a "successful" failover:

- **Logins / SIDs missing** on the new primary (orphaned users) or mismatched passwords.
- **Connection string** pointing to a server name, not the AG **listener**, or missing {{MultiSubnetFailover=True}} (slow or failed connection to multi-subnet listeners).
- **Agent jobs, linked servers, certificates, credentials** not present on the secondary.
- **DNS/connection pooling**: applications holding dead pooled connections without retry logic.
- **Async replica** promoted with data loss, causing application errors.
- Firewall rules or DNS TTL issues in DR.

Immediate fix: correct logins/connection strings, restart pools. Long term: sync server-level objects automatically (dbatools, **contained AG** in 2022), connection resiliency in the app (retry on transient errors), regular failover drills measured against RTO, and monitoring that tests the application path, not just the replica state.`,
  pts: [r`Server objects are outside the AG`, r`Listener + MultiSubnetFailover`, r`App retry logic`, r`Drills measure real RTO`],
  ex: r`A quarterly drill revealed a missing login for the reporting service before a real outage did.`,
  fu: [r`What is a contained availability group?`],
  pit: [r`Testing failover of the database but not of the applications.`] },

{ id: 'q42', level: 'Principal', tags: ['t-sql', 'query', 'reconciliation'],
  q: r`Write a reconciliation between our ledger and a bank statement file: classify every break, handle duplicates and timing differences, and make it fast on millions of rows.`,
  a: r`Reconciliation is a **FULL OUTER JOIN** on a match key followed by classification, but the hard parts are the matching rules and scale.

### Matching rules (agree them with finance first)
1. Exact match on reference + amount + currency.
2. Tolerant match: same amount and currency, value dates within N business days (timing differences).
3. Many-to-one: one bank line settles several ledger entries (batch payouts), matched on sums.

### Break classes
- **Missing in ledger** (bank only): unbooked fees, unknown receipts.
- **Missing at bank** (ledger only): not yet settled, or failed payment.
- **Amount mismatch**: FX, fees deducted, partial settlement.
- **Duplicate**: the same reference twice on one side; must be detected **before** joining, otherwise the join multiplies rows.

### Scale and correctness
Stage both sides into tables with computed match keys and indexes; run passes from strict to tolerant, marking matched rows so later passes only see leftovers; keep results immutable per run (run id) for audit; never update source data. Totals per class must reconcile back to the control totals of both files.`,
  code: r`~~~sql
-- 0. Duplicates inside each side (would multiply join results)
SELECT Reference, COUNT(*) FROM recon.Bank WHERE RunId = @run GROUP BY Reference HAVING COUNT(*) > 1;

-- 1. Strict pass: classify every row (filter each side by run BEFORE the outer join)
WITH l AS (SELECT * FROM recon.Ledger WHERE RunId = @run),
     b AS (SELECT * FROM recon.Bank   WHERE RunId = @run)
SELECT COALESCE(l.Reference, b.Reference) AS Reference,
       l.Amount AS LedgerAmount, b.Amount AS BankAmount,
       CASE WHEN l.Reference IS NULL THEN 'MISSING_IN_LEDGER'
            WHEN b.Reference IS NULL THEN 'MISSING_AT_BANK'
            WHEN l.Amount <> b.Amount OR l.Currency <> b.Currency THEN 'AMOUNT_MISMATCH'
            ELSE 'MATCHED' END AS Status
INTO #pass1
FROM l FULL OUTER JOIN b ON b.Reference = l.Reference;

-- 2. Tolerant pass for timing differences: same amount/currency, value date within 3 days, one-to-one
WITH cand AS (
  SELECT l.LedgerId, b.BankId,
         ROW_NUMBER() OVER (PARTITION BY l.LedgerId ORDER BY ABS(DATEDIFF(day, l.ValueDate, b.ValueDate)), b.BankId) AS rl,
         ROW_NUMBER() OVER (PARTITION BY b.BankId ORDER BY ABS(DATEDIFF(day, l.ValueDate, b.ValueDate)), l.LedgerId) AS rb
  FROM recon.UnmatchedLedger l
  JOIN recon.UnmatchedBank b ON b.Amount = l.Amount AND b.Currency = l.Currency
   AND b.ValueDate BETWEEN DATEADD(day, -3, l.ValueDate) AND DATEADD(day, 3, l.ValueDate))
INSERT recon.Matches (RunId, LedgerId, BankId, Rule)
SELECT @run, LedgerId, BankId, 'AMOUNT_DATE_3D' FROM cand WHERE rl = 1 AND rb = 1;

-- 3. Control totals must tie out
SELECT Status, COUNT(*) AS Items, SUM(COALESCE(LedgerAmount, 0)) AS Ledger, SUM(COALESCE(BankAmount, 0)) AS Bank
FROM #pass1 GROUP BY Status;
~~~`,
  pts: [r`FULL OUTER JOIN on a match key, then CASE to classify each break.`, r`Detect duplicates per side before joining, or the join multiplies rows.`, r`Run passes from strict to tolerant and exclude already-matched rows.`, r`Use ROW_NUMBER in both directions to keep tolerant matches one-to-one.`, r`Immutable results per run id, and control totals that tie back to both files.`],
  ex: r`A payments team's daily reconciliation dropped from 3 hours of spreadsheet work to a 6-minute job with 4 matching passes; unexplained breaks fell from about 400 a day to under 20, all genuinely needing investigation.`,
  fu: [r`How would you match one bank line to several ledger entries that sum to it?`, r`How do you make the reconciliation auditable?`],
  pit: [r`Joining before removing duplicates.`, r`A tolerant pass that matches one bank line to several ledger lines.`, r`Updating source tables during reconciliation.`],
  tip: r`Start with "what are the matching rules, agreed with finance?" That is the Principal signal here, not the JOIN.` },

{ id: 'q43', level: 'Principal', tags: ['data-architecture'],
  code: r`~~~sql
-- One database (or schema) per service, one login per service, no cross-database queries
CREATE LOGIN orders_svc WITH PASSWORD = '...'; CREATE USER orders_svc FOR LOGIN orders_svc;
ALTER ROLE db_datareader ADD MEMBER orders_svc; ALTER ROLE db_datawriter ADD MEMBER orders_svc;
-- Reporting reads replicas/CDC streams into a warehouse instead of joining across service databases
~~~`,
  q: r`How should a microservices platform use SQL Server without creating a distributed monolith?`,
  a: r`- **Database per service** (or schema per service with strict permissions): no cross-service joins or shared tables; services integrate through APIs and events.
- **Outbox** in each service's database for reliable event publishing (CDC or polling relay).
- **Read models** built from events for cross-service queries; reporting via a warehouse fed by CDC/events, not by querying service databases directly.
- **Consolidate physically, separate logically** to control cost: many service databases on a shared, well-managed instance or elastic pool, with resource governance to limit noisy neighbours.
- **Reference data** owned by one service and replicated.
- **Sagas** for cross-service transactions instead of distributed transactions.

The anti-pattern to avoid: a shared database with ten services reading and writing each other's tables, which makes every schema change a cross-team release.`,
  pts: [r`Logical isolation per service`, r`Outbox + events, read models`, r`Physical consolidation with governance`, r`No shared tables`],
  ex: r`Ten services on one Azure SQL elastic pool, each with its own database and login, kept costs low while preserving independence.`,
  fu: [r`How do you migrate off a shared database incrementally?`],
  pit: [r`Cross-database joins between service databases.`] },

{ id: 'q44', level: 'Principal', tags: ['t-sql', 'query', 'fraud', 'window-functions'],
  q: r`Fraud rule: flag cards with more than 3 transactions within any 10-minute window, or total spend above 5,000 within 24 hours. Write it and make it scale.`,
  a: r`This is a **sliding time window** problem: "any 10 minutes" means a window that ends at each transaction, not fixed buckets (fixed buckets miss bursts that straddle a boundary).

### Approaches
- **Self-join on a time range**: for each transaction, count the same card's transactions in the previous 10 minutes. Correct and simple; with an index on {{(CardId, TxnAt)}} each probe is a short range seek.
- **APPLY with COUNT**: same idea, often a clearer plan.
- **LAG(TxnAt, 3)**: "more than 3 in 10 minutes" is equivalent to "the 3rd previous transaction is within 10 minutes", which is a single scan and the fastest. Interviewers like this insight.
- SQL Server window frames support ROWS but not time-based RANGE intervals, so for the 24-hour spend rule use APPLY with a range predicate.

### Scale and production
Batch SQL is fine for after-the-fact investigations and model features. **Real-time** authorisation decisions (under 50 ms) belong in a streaming system or an in-memory velocity store (Redis sorted sets, Flink), with SQL used to backtest rules on history. Deduplicate retries and reversals first, or legitimate retries look like velocity.`,
  code: r`~~~sql
-- More than 3 transactions in 10 minutes: the 3rd previous one is within 10 minutes (single scan)
SELECT CardId, TxnId, TxnAt
FROM (SELECT CardId, TxnId, TxnAt,
             LAG(TxnAt, 3) OVER (PARTITION BY CardId ORDER BY TxnAt, TxnId) AS ThirdPrev
      FROM dbo.CardTxns WHERE TxnAt >= DATEADD(day, -1, SYSUTCDATETIME()) AND Status <> 'REVERSED') x
WHERE ThirdPrev >= DATEADD(minute, -10, TxnAt);

-- Spend above 5,000 within the 24 hours ending at each transaction
SELECT t.CardId, t.TxnId, t.TxnAt, w.Spend24h
FROM dbo.CardTxns t
CROSS APPLY (SELECT SUM(p.Amount) AS Spend24h
             FROM dbo.CardTxns p
             WHERE p.CardId = t.CardId AND p.TxnAt > DATEADD(hour, -24, t.TxnAt) AND p.TxnAt <= t.TxnAt) w
WHERE w.Spend24h > 5000 AND t.TxnAt >= DATEADD(day, -1, SYSUTCDATETIME());

CREATE INDEX IX_CardTxns_Card_Time ON dbo.CardTxns (CardId, TxnAt) INCLUDE (Amount, Status);
~~~`,
  pts: [r`"Any 10 minutes" is a sliding window ending at each transaction, not fixed buckets.`, r`LAG(TxnAt, 3) within 10 minutes detects "more than 3" in a single scan.`, r`APPLY with a time-range predicate handles sum-over-24-hours rules.`, r`Index (CardId, TxnAt) INCLUDE (Amount) so every probe is a short seek.`, r`Real-time decisions belong in a streaming/velocity store; SQL backtests rules.`],
  ex: r`A card issuer backtested a new velocity rule over 18 months of transactions in SQL before deploying it to the real-time engine; the backtest showed the rule would have flagged 0.4% of genuine customers, so the threshold was raised before launch.`,
  fu: [r`How would you count distinct merchants per card in the last hour?`, r`How do retries and reversals distort velocity rules?`],
  pit: [r`Fixed 10-minute buckets that miss bursts across a boundary.`, r`Running the query over all history without a time filter.`] },

{ id: 'q45', level: 'Principal', tags: ['t-sql', 'query', 'relational-division'],
  q: r`Find customers who bought every product in a given set (relational division), and the smallest set of customers that makes up 80% of revenue.`,
  a: r`### Relational division
"Customers who bought **all** of products A, B and C" cannot be expressed with a simple join. Two standard solutions:

- **Count method**: filter to the target products, group by customer, and require {{COUNT(DISTINCT ProductId)}} equal to the size of the set. Fast and readable.
- **Double NOT EXISTS**: "there is no target product that the customer has not bought". Logically pure, handles "exact division" variants, slower to read.

Decide with the interviewer whether "exactly these products and nothing else" is meant (exact division): add a condition that the customer bought no other products.

### Pareto (80% of revenue)
Rank customers by revenue, compute the running share of total, and keep customers until the running share reaches 80%. Include the customer that **crosses** the threshold: filter on the running share **before** adding the current customer being below 80%.

These two queries test whether a candidate thinks in sets rather than loops.`,
  code: r`~~~sql
-- Customers who bought ALL products in the target set (count method)
DECLARE @target TABLE (ProductId int PRIMARY KEY);
INSERT @target VALUES (101), (205), (309);
SELECT o.CustomerId
FROM dbo.OrderLines ol JOIN dbo.Orders o ON o.OrderId = ol.OrderId
WHERE ol.ProductId IN (SELECT ProductId FROM @target)
GROUP BY o.CustomerId
HAVING COUNT(DISTINCT ol.ProductId) = (SELECT COUNT(*) FROM @target);

-- Same with double NOT EXISTS
SELECT c.CustomerId FROM dbo.Customers c
WHERE NOT EXISTS (
  SELECT 1 FROM @target t
  WHERE NOT EXISTS (SELECT 1 FROM dbo.OrderLines ol JOIN dbo.Orders o ON o.OrderId = ol.OrderId
                    WHERE o.CustomerId = c.CustomerId AND ol.ProductId = t.ProductId));

-- Customers making up 80% of revenue (include the one that crosses the line)
WITH rev AS (SELECT CustomerId, SUM(Total) AS Revenue FROM dbo.Orders GROUP BY CustomerId),
cum AS (SELECT CustomerId, Revenue,
               SUM(Revenue) OVER (ORDER BY Revenue DESC, CustomerId ROWS UNBOUNDED PRECEDING) AS RunningRev,
               SUM(Revenue) OVER () AS TotalRev
        FROM rev)
SELECT CustomerId, Revenue, 100.0 * RunningRev / TotalRev AS CumPct
FROM cum
WHERE RunningRev - Revenue < 0.8 * TotalRev
ORDER BY Revenue DESC;
~~~`,
  pts: [r`Relational division: filter to the set, GROUP BY customer, HAVING COUNT(DISTINCT) = set size.`, r`Double NOT EXISTS expresses "no target product not bought".`, r`Clarify exact division (only these products) versus at least these.`, r`Pareto: running SUM over revenue DESC divided by the total.`, r`Include the row that crosses the threshold by testing the running total before it.`],
  ex: r`A cross-sell team used relational division to find clients holding all three core products (current account, card, savings), then the Pareto query to show that 7% of clients produced 80% of fee revenue, which reshaped relationship-manager coverage.`,
  fu: [r`Find customers who bought exactly the set and nothing else.`, r`How would you do this per month efficiently?`],
  pit: [r`COUNT(*) instead of COUNT(DISTINCT), so repeat purchases fake a match.`, r`Dropping the customer that crosses the 80% line.`] },

{ id: 'q46', level: 'Principal', tags: ['indexes', 'design'],
  code: r`~~~sql
-- OLTP: clustered on OrderId; point lookups by public id
CREATE UNIQUE INDEX UX_Orders_PublicId ON dbo.Orders (PublicId);
-- Customer screens: covering index for "my orders" newest first
CREATE INDEX IX_Orders_Customer ON dbo.Orders (CustomerId, CreatedUtc DESC) INCLUDE (Status, Total);
-- Finance reports: nonclustered columnstore for aggregates, partitioned by month for retention
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Orders ON dbo.Orders (CreatedUtc, Status, Total, Currency, MerchantId);
-- Free-text customer search goes to a search index, not LIKE '%x%' on 300 M rows
~~~`,
  q: r`An Orders table (300M rows) serves OLTP lookups, customer search screens and finance reports. Design its indexing and data-access strategy.`,
  a: r`### Separate the workloads first
One table cannot be optimal for point writes, ad-hoc search, and large aggregations at the same time. Decide per workload:

| Workload | Access pattern | Strategy |
|---|---|---|
| OLTP (create, get by id, list by customer) | Point and narrow range | Clustered on {{BIGINT IDENTITY}} {{OrderId}}; NCI {{(CustomerId, CreatedAt DESC) INCLUDE (Status, Total)}}; unique NCI on {{ExternalRef}} for idempotency |
| Back-office search (any of 12 filters, free text) | Unpredictable predicates | Do not index every combination; move to a search index (OpenSearch) fed by CDC/outbox, or a few composite indexes for the top 3 filter combinations found in Query Store |
| Finance reports (sums by day, merchant, currency) | Large scans and aggregations | Non-clustered **columnstore** on the table (operational analytics) or a separate reporting store/warehouse; partition by month for archive |

### Rules applied
- Every index justified by a **named query** from Query Store with its frequency and cost; unused indexes ({{sys.dm_db_index_usage_stats}}, observed over a full business cycle including month-end) removed.
- Write budget: each extra index adds write latency and log volume; measure insert p99 before and after.
- Filtered indexes for hot subsets ({{WHERE Status IN ('Pending','Processing')}}) instead of full-table indexes on low-selectivity columns.
- Read replicas for search/report traffic if it stays in SQL Server; stale-by-seconds is acceptable there.

### Governance
Index changes go through migrations with a review checklist (online build, size, write impact), and a quarterly index review.`,
  pts: [r`Different workloads, different structures`, r`Every index tied to a measured query`, r`Columnstore or warehouse for reports`, r`Search engine for free-form search`, r`Filtered indexes for hot subsets`],
  ex: r`An orders table had 27 indexes added over years; usage stats over a quarter showed 11 unused. Removing them cut insert latency by 40% and the log volume by a third, while search moved to OpenSearch.`,
  fu: [r`How do you decide to drop an index safely?`, r`What changes if the table is partitioned?`],
  pit: [r`Adding every missing-index suggestion.`, r`Measuring index usage over a week that excludes month-end.`],
  tip: r`Asking "which queries and how often?" before proposing any index is the Principal signal.` },

{ id: 'q47', level: 'Principal', tags: ['migrations', 'zero-downtime'],
  code: r`~~~sql
-- Expand: add nullable column (metadata-only), backfill in batches, then enforce
ALTER TABLE dbo.Customers ADD NormalizedEmail nvarchar(256) NULL;
WHILE 1 = 1 BEGIN
  UPDATE TOP (5000) dbo.Customers SET NormalizedEmail = LOWER(Email) WHERE NormalizedEmail IS NULL;
  IF @@ROWCOUNT = 0 BREAK; WAITFOR DELAY '00:00:01';
END
CREATE UNIQUE INDEX UX_Customers_NormEmail ON dbo.Customers (NormalizedEmail) WITH (ONLINE = ON, RESUMABLE = ON);
-- Contract (a later release, once no code reads Email): drop the old column
~~~`,
  q: r`How do you deploy schema changes with zero downtime?`,
  a: r`Use **expand/contract** so old and new application versions work with the schema at every step:

1. **Expand**: add new nullable column/table/index (online), deploy code that writes both old and new.
2. **Backfill** in small batches (avoid long locks and log growth), with throttling.
3. **Switch reads** to the new structure; verify.
4. **Contract**: remove old writes, then drop the old column in a later release.

Specifics: {{CREATE INDEX ... WITH (ONLINE = ON, RESUMABLE = ON)}}; adding a NOT NULL column with a default is metadata-only on modern versions (Enterprise/Azure); renames break older code (avoid, or use views/synonyms during transition); large data changes in batches of a few thousand rows with {{WAITFOR}} delays; check AG replica lag. Run migrations from the pipeline, idempotent and reviewed, with a tested rollback path (which may be "roll forward").`,
  pts: [r`Expand, backfill, switch, contract`, r`Online, resumable index operations`, r`Batch backfills`, r`Never rename in one step`],
  ex: r`Splitting {{Name}} into {{FirstName}}/{{LastName}} took three releases with no downtime.`,
  fu: [r`How do you handle a column type change on a 1-billion-row table?`],
  pit: [r`A migration that drops a column the previous app version still reads.`] },

{ id: 'q48', level: 'Principal', tags: ['architecture', 'stored-procedures', 'governance', 'testing'],
  q: r`Business logic in stored procedures or in the application? Give your decision framework, then explain how you version, test, deploy and govern database code (procedures, functions, views, triggers) across many teams.`,
  a: r`### Decision framework
| Put it in the database when | Put it in the application when |
|---|---|
| It is a **data-integrity invariant** (balanced journal, no negative balance, uniqueness) | It is **workflow or orchestration** (call a KYC provider, send a notification, saga steps) |
| It is **set-based heavy lifting** close to the data (allocation, reconciliation, month-end aggregation) | It needs **horizontal scale**: app servers are cheap; SQL Server cores are the most expensive CPU you own (licensing) |
| One atomic statement replaces several round trips under contention (balance check plus debit) | It changes often, needs feature flags, A/B tests or rich unit testing |
| The procedure is a **security boundary** (EXECUTE-only logins) | It must be portable across databases or owned by a team without T-SQL depth |

My default for a .NET platform: **thin, set-based procedures (or well-reviewed EF Core queries) for data operations and invariants; business rules and orchestration in the service**. No business logic in triggers. No procedure that calls other services. Reporting and batch logic can live in the database when it is set-based.

### Versioning and compatibility
- All database code lives in **Git** next to the service: SSDT (dacpac), DbUp, Flyway or EF Core migrations, with {{CREATE OR ALTER}} scripts that are idempotent.
- **Backward-compatible changes first** (expand/contract): add new optional parameters at the end with defaults, new result columns at the end, never rename in place. For breaking changes, ship {{Order_Create_v2}} alongside v1, migrate callers, then drop v1.
- Treat the procedure signature and result shape as a **public API**: contract tests in the calling service check {{sys.dm_exec_describe_first_result_set}} output.

### Testing
- **tSQLt** unit tests: {{FakeTable}} isolates the procedure from real data, {{SpyProcedure}} mocks calls, assertions on result tables; run in CI against a container (SQL Server on Linux).
- Integration tests with **Testcontainers** from the .NET test suite, including concurrency tests (two sessions racing the same account).
- Performance gate: run the migration and hot procedures against a production-sized, masked copy; compare Query Store metrics.

### Deployment and governance
- Pipeline-only deployment; no hand-run scripts in production; break-glass access is logged.
- Static analysis in CI: SQL Code Analysis rules, a linter (for example SqlFluff T-SQL dialect) plus house rules: {{SET XACT_ABORT ON}} in every procedure, no {{NOLOCK}}, no {{SELECT *}}, schema-qualified names, no dynamic SQL without sp_executesql.
- **One owner per database**; other teams integrate via APIs or events, never by calling another service's procedures.
- Observability: {{sys.dm_exec_procedure_stats}} and Query Store by module; alert on regressions after each release.
- A DDL trigger or audit records every change made outside the pipeline.`,
  dia: r`flowchart LR
  Dev[Developer: proc change in Git] --> PR[Pull request]
  PR --> Lint[Static analysis and house rules]
  PR --> T[tSQLt and Testcontainers tests]
  T --> Perf[Prod-sized masked copy: Query Store compare]
  Lint --> Gate{All gates pass}
  Perf --> Gate
  Gate -- yes --> Dep[Pipeline deploys dacpac or migrations]
  Dep --> Obs[Query Store and proc stats alerts]
  Gate -- no --> Dev`,
  code: r`~~~sql
-- tSQLt: unit test the debit procedure in isolation
EXEC tSQLt.NewTestClass 'AccountTests';
GO
CREATE OR ALTER PROCEDURE AccountTests.[test debit fails when funds are insufficient]
AS
BEGIN
  EXEC tSQLt.FakeTable 'dbo.Accounts';
  INSERT dbo.Accounts (AccountId, Balance) VALUES (1, 50.00);
  DECLARE @nb decimal(19,4), @rc int;
  EXEC @rc = dbo.Account_Debit @AccountId = 1, @Amount = 80.00, @NewBalance = @nb OUTPUT;
  EXEC tSQLt.AssertEquals 1, @rc;
  DECLARE @bal decimal(19,4) = (SELECT Balance FROM dbo.Accounts WHERE AccountId = 1);
  EXEC tSQLt.AssertEquals 50.00, @bal;
END;
GO
EXEC tSQLt.Run 'AccountTests';

-- Backward-compatible change: new optional parameter at the end, old callers unaffected
CREATE OR ALTER PROCEDURE dbo.Order_Create
  @CustomerId bigint, @Total decimal(19,4),
  @Channel varchar(20) = 'web'          -- added in release 42
AS ...;

-- Contract check used by the calling service's tests
SELECT name, system_type_name, is_nullable
FROM sys.dm_exec_describe_first_result_set(N'EXEC dbo.Customers_Search @Name = N''a''', NULL, 0);

-- Which procedures cost the most since the last release?
SELECT TOP (20) OBJECT_NAME(object_id, database_id) AS proc_name, execution_count,
       total_worker_time / execution_count AS avg_cpu_us, total_logical_reads / execution_count AS avg_reads
FROM sys.dm_exec_procedure_stats ORDER BY total_worker_time DESC;
~~~`,
  pts: [r`Database: invariants, set-based work, atomic contention-sensitive operations, security boundary.`, r`Application: workflows, integrations, frequently changing rules, anything needing horizontal scale.`, r`SQL Server CPU is the most expensive compute you own: keep chatty logic out.`, r`Procedures are APIs: expand/contract, versioned names, contract tests.`, r`tSQLt plus Testcontainers in CI, static analysis, pipeline-only deploys, one owner per database.`],
  ex: r`A bank had 4,000 stored procedures with business rules spread across them, no tests, and every release needed a DBA weekend. The programme moved orchestration rules into services, kept 300 set-based procedures (postings, allocation, month-end), added tSQLt coverage and dacpac deployments, and cut SQL Server core licences by 40% as CPU moved to cheaper app nodes.`,
  fu: [r`How do you migrate logic out of procedures without a big-bang rewrite?`, r`How do you handle a hotfix to a procedure while a v2 is in flight?`, r`What would make you move logic into the database rather than out of it?`],
  pit: [r`Dogma in either direction ("all logic in procs" or "the DB is just storage").`, r`Breaking procedure result shapes that other services silently depend on.`, r`Untested T-SQL deployed by hand.`],
  tip: r`Bring licensing cost into the answer: it is the argument executives understand, and it shows principal-level thinking.` },

{ id: 'q49', level: 'Principal', tags: ['security', 'stored-procedures', 'rls', 'encryption'],
  q: r`Design the data-security model for a multi-tenant payments database: procedure-only access, ownership chaining, EXECUTE AS vs module signing, row-level security, Always Encrypted, TDE, masking and ledger tables. Which security functions do you use?`,
  a: r`### Layered model
1. **Network and identity**: TLS enforced ({{Encrypt=True}}, valid certificates), Entra ID or managed identities, no shared SQL logins, no sysadmin for applications.
2. **Procedure-only access**: the app's database user has {{EXECUTE}} on a schema of procedures and nothing else.
3. **Row-level security** for tenant isolation.
4. **Encryption**: TDE at rest, Always Encrypted for the few columns the DBA must not read.
5. **Tamper evidence and audit**: ledger tables and SQL Server Audit.

### Ownership chaining
When a procedure and the tables it touches have the **same owner**, SQL Server checks permission only on the procedure: that is what makes EXECUTE-only access work. The chain **breaks** for dynamic SQL, for cross-database access (unless cross-database chaining is on, which you should not enable) and when owners differ.

### EXECUTE AS vs module signing
- {{EXECUTE AS OWNER}} makes the whole procedure run as the owner (often dbo): any injection inside it gets dbo rights, and {{ORIGINAL_LOGIN()}} is needed to know the real caller.
- **Module signing**: sign the procedure with a certificate, create a user from the certificate, and grant that user exactly what the procedure needs. Any change to the procedure drops the signature, so a tampered procedure loses its rights. This is the recommended way.
- {{TRUSTWORTHY ON}} plus a dbo owned by sysadmin is a known privilege-escalation path; keep it OFF.

### Row-level security
An inline TVF predicate plus a security policy. **Filter predicates** hide other tenants' rows from SELECT, UPDATE and DELETE; **block predicates** stop writes into another tenant. The tenant comes from {{SESSION_CONTEXT(N'TenantId')}}, set once per connection by the app with {{@read_only = 1}}. Pooled connections keep session context, so set it at the start of every request or use connection resiliency hooks. Admin and ETL users need an explicit bypass in the predicate. Watch for side-channel inference (divide-by-zero errors), and index the tenant column.

### Encryption and masking
- **TDE**: files and backups at rest; transparent; does not protect against a logged-in user.
- **Always Encrypted** (with secure enclaves for range and LIKE): keys live in Key Vault, held by the client driver; the server never sees plaintext. Deterministic encryption allows equality lookups only.
- **Dynamic data masking** is a presentation convenience, **not** a security boundary: a user can infer values with WHERE predicates.
- **PAN and secrets**: tokenise outside the database to shrink PCI scope.

### Ledger tables (2022)
Updatable or append-only ledger tables keep a cryptographic hash chain of changes; database digests stored in immutable storage let an auditor **prove** no one, including a DBA, altered history.

### Security functions
{{SESSION_CONTEXT}}, {{ORIGINAL_LOGIN()}} (the real caller, even under EXECUTE AS), {{SUSER_SNAME()}}, {{USER_NAME()}}, {{IS_MEMBER}}, {{IS_ROLEMEMBER}}, {{HAS_PERMS_BY_NAME}}, {{HASHBYTES('SHA2_256', ...)}} for fingerprints, {{CRYPT_GEN_RANDOM}} for secure random values.`,
  code: r`~~~sql
-- Procedure-only access
CREATE ROLE app_exec;
GRANT EXECUTE ON SCHEMA::api TO app_exec;          -- no SELECT/INSERT on dbo tables
ALTER ROLE app_exec ADD MEMBER [payments-api-mi];  -- managed identity user

-- Row-level security for tenants
CREATE SCHEMA sec;
GO
CREATE FUNCTION sec.fn_tenant (@TenantId int) RETURNS TABLE WITH SCHEMABINDING AS
RETURN SELECT 1 AS ok
WHERE @TenantId = CAST(SESSION_CONTEXT(N'TenantId') AS int)
   OR IS_ROLEMEMBER('etl_bypass') = 1;
GO
CREATE SECURITY POLICY sec.TenantPolicy
  ADD FILTER PREDICATE sec.fn_tenant(TenantId) ON dbo.Payments,
  ADD BLOCK  PREDICATE sec.fn_tenant(TenantId) ON dbo.Payments AFTER INSERT
WITH (STATE = ON);
-- per request, from the app:
EXEC sys.sp_set_session_context @key = N'TenantId', @value = 42, @read_only = 1;

-- Append-only ledger table: tamper-evident history (2022)
CREATE TABLE dbo.PostingsLedger (
  PostingId bigint NOT NULL, AccountId bigint NOT NULL, Amount decimal(19,4) NOT NULL, PostedUtc datetime2(3) NOT NULL)
WITH (LEDGER = ON (APPEND_ONLY = ON));
EXEC sys.sp_verify_database_ledger_from_digest_storage;   -- auditor verification

-- Masking is not security: a masked user can still probe values
ALTER TABLE dbo.Customers ALTER COLUMN Phone ADD MASKED WITH (FUNCTION = 'partial(0,"XXXXXXX",4)');
SELECT CustomerId FROM dbo.Customers WHERE Phone LIKE '07700%';  -- still returns matching rows

-- Who really called?
SELECT ORIGINAL_LOGIN() AS RealCaller, SUSER_SNAME() AS EffectiveLogin, USER_NAME() AS DbUser;
~~~`,
  pts: [r`EXECUTE-only app users rely on ownership chaining; dynamic SQL and cross-database calls break it.`, r`Module signing over EXECUTE AS OWNER; keep TRUSTWORTHY OFF.`, r`RLS with SESSION_CONTEXT, filter plus block predicates, reset per request on pooled connections.`, r`TDE at rest, Always Encrypted for DBA-proof columns, masking is not a control, tokenise PANs.`, r`Ledger tables give cryptographic tamper evidence for auditors.`],
  ex: r`During a SaaS payments audit, the tenant-isolation evidence was an RLS policy with block predicates, a test suite that tried cross-tenant reads and writes on every build, and procedure-only access for the API identity. A later bug that forgot a tenant filter in a new query was caught by RLS in staging rather than becoming a breach.`,
  fu: [r`How do you stop session context leaking between requests on a pooled connection?`, r`What can Always Encrypted not do, and how do enclaves change that?`, r`How would you give support engineers read access without exposing card data?`],
  pit: [r`Treating dynamic data masking as protection for sensitive data.`, r`EXECUTE AS OWNER on procedures containing dynamic SQL.`, r`An RLS predicate on an unindexed tenant column (every query scans).`] },

{ id: 'q50', level: 'Principal', tags: ['code-review', 't-sql'],
  q: r`Code review: what is wrong with this stored procedure that applies a fee to an account?`,
  a: r`~~~sql
CREATE PROCEDURE dbo.ApplyFee @AccountId int, @Fee float AS
BEGIN
  DECLARE @bal float;
  SELECT @bal = Balance FROM Accounts WITH (NOLOCK) WHERE AccountId = @AccountId;
  IF @bal >= @Fee
  BEGIN
    BEGIN TRAN
      UPDATE Accounts SET Balance = @bal - @Fee WHERE AccountId = @AccountId;
      INSERT INTO FeeLog VALUES (@AccountId, @Fee, GETDATE());
    COMMIT
  END
END
~~~

Findings, most severe first:

1. **Lost update / race**: balance read outside the transaction, then written as {{@bal - @Fee}}. Two concurrent calls both read 100 and both write 90: one fee is lost (or worse, a concurrent deposit is overwritten). Use an atomic conditional update: {{UPDATE ... SET Balance = Balance - @Fee WHERE AccountId = @AccountId AND Balance >= @Fee}} and check {{@@ROWCOUNT}}.
2. **{{NOLOCK}}** reads uncommitted data (a deposit that later rolls back) to make a financial decision.
3. **{{float}} for money**: binary rounding errors; use {{decimal(19,4)}} matching the column.
4. **No idempotency**: a client retry after a timeout charges twice. Accept a {{@RequestId}} with a unique constraint in {{FeeLog}}.
5. **No error handling**: without {{SET XACT_ABORT ON}} and TRY/CATCH a failure between statements can leave an open transaction or a partial write.
6. {{INSERT ... VALUES}} without a column list breaks when the table changes.
7. {{GETDATE()}} is local server time; use {{SYSUTCDATETIME()}}.
8. Missing schema-qualification on {{Accounts}}/{{FeeLog}} (minor plan-cache and resolution cost), no {{SET NOCOUNT ON}}.

~~~sql
CREATE OR ALTER PROCEDURE dbo.ApplyFee @AccountId bigint, @Fee decimal(19,4), @RequestId uniqueidentifier AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  BEGIN TRAN;
    INSERT dbo.FeeLog (RequestId, AccountId, Fee, CreatedUtc) VALUES (@RequestId, @AccountId, @Fee, SYSUTCDATETIME()); -- unique RequestId: duplicate retry fails fast
    UPDATE dbo.Accounts SET Balance = Balance - @Fee WHERE AccountId = @AccountId AND Balance >= @Fee;
    IF @@ROWCOUNT = 0 THROW 50020, 'Insufficient funds', 1;
  COMMIT;
END
~~~

(The caller treats a duplicate-key error on {{RequestId}} as "already applied" and returns the original result.)`,
  pts: [r`Read-then-write race: use atomic conditional update`, r`NOLOCK for money decisions`, r`float for money`, r`Idempotency via unique request id`, r`XACT_ABORT and error handling`],
  ex: r`This exact read-modify-write pattern caused a fee to be charged twice and a deposit to vanish under load in a retail-banking batch; the conditional update eliminated both.`,
  fu: [r`How would you test for the race condition?`, r`Why insert the log row before the update?`],
  pit: [r`Fixing only the data type and missing the race.`, r`Adding HOLDLOCK everywhere instead of a single atomic statement.`] }
],
cheat: r`### Storage and indexes
Clustered = table (narrow, unique, static, increasing key). Non-clustered leaf holds clustering key → key lookups. Covering via INCLUDE. Every index taxes writes. Columnstore for analytics, rowstore for OLTP.

### Plans
Estimates drive everything → statistics matter. Read actual plans: estimate vs actual, lookups, scans, spills, CONVERT_IMPLICIT. SARGable predicates; half-open date ranges; match parameter types. Parameter sniffing → RECOMPILE / OPTIMIZE FOR / Query Store forcing / PSP (2022).

### Programmable objects
| Object | Rule |
|---|---|
| Stored procedure | API + security boundary + transaction; SET NOCOUNT ON, SET XACT_ABORT ON, TRY/CATCH, THROW |
| Scalar UDF | Per-row black box; check is_inlineable (2019); rewrite as inline TVF + APPLY |
| Multi-statement TVF | Table variable, 100-row guess; avoid |
| Inline TVF | Expanded like a parameterised view: the fast one |
| View | Expanded inline; one level deep; SCHEMABINDING |
| Indexed view | SCHEMABINDING, COUNT_BIG(*), deterministic, NOEXPAND; synchronous write cost |
| Trigger | Once per statement, inside caller txn; join inserted/deleted; EF Core HasTrigger |
| Cursor | LOCAL FAST_FORWARD, CLOSE + DEALLOCATE; only for batching/admin; prefer set-based |
| Dynamic SQL | sp_executesql + parameters; QUOTENAME + allow-list for identifiers; module signing |
| #temp vs @table | Temp has stats; table variable survives ROLLBACK; CTE is not materialised |
| TVP | Sets from .NET in one round trip (SqlDbType.Structured) |

### Error handling
XACT_ABORT ON (client timeout skips CATCH) · CATCH: IF @@TRANCOUNT > 0 ROLLBACK; log; THROW; · XACT_STATE() -1 doomed · nested COMMIT only decrements, use SAVE TRANSACTION · ERROR_NUMBER/MESSAGE/LINE/PROCEDURE.

### Built-in function catalogue
| Family | Functions and the one thing to remember |
|---|---|
| NULL and logic | ISNULL (first arg type, 2 args) · COALESCE (CASE, precedence) · NULLIF (div by zero) · IIF · CHOOSE · GREATEST/LEAST (2022, ignore NULLs) · IS DISTINCT FROM |
| Identity | SCOPE_IDENTITY · @@IDENTITY (trigger trap) · IDENT_CURRENT (any session) · OUTPUT inserted · NEXT VALUE FOR · sp_sequence_get_range |
| System | @@ROWCOUNT (capture at once) · ROWCOUNT_BIG · @@TRANCOUNT · XACT_STATE · @@SPID · SESSION_CONTEXT |
| Date and time | SYSUTCDATETIME · SYSDATETIMEOFFSET · DATEADD (month clamps) · DATEDIFF (boundaries) · DATEDIFF_BIG · EOMONTH · DATEFROMPARTS · DATETRUNC · DATE_BUCKET · DATEPART iso_week · AT TIME ZONE |
| String | STRING_AGG (cast max) · STRING_SPLIT (ordinal) · CONCAT/CONCAT_WS · TRIM · TRANSLATE · CHARINDEX · PATINDEX · SUBSTRING · STUFF · REPLICATE · LEN vs DATALENGTH · QUOTENAME · FORMAT (slow) |
| Conversion | CAST · CONVERT (styles 112, 126) · TRY_CAST/TRY_CONVERT (validation) · PARSE (slow) · avoid ISNUMERIC |
| Maths | ROUND (x,n,1 truncates) · FLOOR · CEILING · ABS · SIGN · POWER · SQRT · LOG/EXP (product via EXP(SUM(LOG))) · CRYPT_GEN_RANDOM |
| Ranking | ROW_NUMBER (unique) · RANK (gaps) · DENSE_RANK (Nth distinct) · NTILE |
| Analytic | LAG/LEAD · FIRST_VALUE/LAST_VALUE (ROWS frame) · IGNORE NULLS (2022) · PERCENTILE_CONT/DISC · CUME_DIST · PERCENT_RANK |
| Aggregate | COUNT_BIG · COUNT(DISTINCT) · AVG (int stays int) · STDEV · STRING_AGG · GROUPING/GROUPING_ID · APPROX_COUNT_DISTINCT · APPROX_PERCENTILE_CONT |
| JSON | JSON_VALUE (scalar) · JSON_QUERY (fragment) · OPENJSON WITH · JSON_MODIFY · ISJSON (CHECK) · FOR JSON PATH · JSON_OBJECT/JSON_ARRAY (2022) |
| Security and hashing | ORIGINAL_LOGIN · SUSER_SNAME · USER_NAME · IS_ROLEMEMBER · HAS_PERMS_BY_NAME · HASHBYTES SHA2_256 · CHECKSUM (collisions) |

### Concurrency
| Problem | Fix |
|---|---|
| Readers vs writers blocking | RCSI |
| Deadlock 1205 | Consistent order, covering index, short txn, UPDLOCK, app retry |
| Lock escalation (~5,000 locks) | Batch, index, partition-level escalation |
| Queue table | UPDLOCK + READPAST + lease |
| Duplicates under concurrency | UNIQUE index (idempotency key) |
| Open txn on error | SET XACT_ABORT ON |

### T-SQL query patterns (most asked)
| Problem | Pattern |
|---|---|
| Nth highest salary | DENSE_RANK() = N; scalar OFFSET N-1 FETCH 1 for NULL-if-missing |
| Top earner per department | RANK() OVER (PARTITION BY dept ORDER BY salary DESC) = 1 |
| Duplicates | ROW_NUMBER CTE, DELETE where rn > 1, then a unique index |
| Never ordered | NOT EXISTS (never NOT IN with NULLs) |
| Top-N per group | ROW_NUMBER <= N, or OUTER APPLY TOP (N) with index (group, sort DESC) |
| Consecutive days | date - ROW_NUMBER() = island key; LEAD for gaps |
| Running total | SUM() OVER (ORDER BY d, id ROWS UNBOUNDED PRECEDING) |
| FIFO allocation | Running-total ranges, overlap = LEAST(ends) - GREATEST(starts) |
| MoM / YoY | Aggregate per month, LAG; join on DATEADD(year, -1, m) |
| Subtotals | GROUPING SETS / ROLLUP + GROUPING_ID |
| Median | PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER (PARTITION BY g) |
| Hierarchy | Recursive CTE, path + MAXRECURSION as cycle guard |
| Pivot | SUM(CASE ...) or dynamic PIVOT with QUOTENAME + sp_executesql |
| Bought all of a set | GROUP BY customer HAVING COUNT(DISTINCT product) = set size |

### Say this
"XACT_ABORT ON, because timeouts skip CATCH." "Inline TVFs only." "Triggers fire per statement." "NOLOCK is not a fix." "Query Store first, then fix." "Append-only ledger, corrections are reversals." "SQL Server cores are the most expensive CPU you own."`
});
})(String.raw);
