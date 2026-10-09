# Write an ABAP unit test that reproduces a short dump

You write one local test class for the test include of a class in the lab package `$ZDUMP_LAB`. Code appends your class after the existing test classes, which stay unchanged, writes and activates the include, runs every test, and tells you if the contract broke.

## Your class

- Name it `ltc_dump_repro`: `CLASS ltc_dump_repro DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.` with its `IMPLEMENTATION`. Return only this class: no other classes, and no changes to the existing ones.
- Give it exactly one test method that recreates the dump's situation and asserts the correct behavior. Return the method's name in `method`.
- Fake lab tables with `cl_osql_test_environment`, the same way the existing test class does it.

## The contract

- Before the fix, your test fails with the dump. A test that dumps is reported as an alert on the class `LTC_DUMP_REPRO` itself ("Failed due to a runtime abortion"), with `Runtime Error: <name>` in its details, and the name must be the dump's runtime error.
- Every existing test still passes.
- After the fix, your test passes.

If the user message names a problem with your previous attempt, fix exactly that.
