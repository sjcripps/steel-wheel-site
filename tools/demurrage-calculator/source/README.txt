BNSF Demurrage Calculator — Rate Source

Live rates baked into ../index.html come from:
  BNSF Demurrage Book 6004-C, effective July 1, 2025.

The full text is archived alongside this README at:
  bnsf-6004-c-2025-07-01.txt

When BNSF publishes a new effective date (historically Q2 each year),
re-pull the new book from https://www.bnsf.com (search "Demurrage Book"),
diff against this archive, and update:

  tools/demurrage-calculator/index.html
    - RATE_BOOK_VERSION constant
    - RATES table (free_days / base_days / base_rate / edf_rate per type)
    - HAZMAT_PER_DAY  (currently $135/day)
    - HOLD_FOR_INSTR  (currently $420/car one-time)
    - Disclaimer copy referencing the effective date
    - .badge text in the hero ("Free Tool · BNSF Book 6004-X")

Smoke-test the math after every rate change. The expected scenarios are
documented in the commit message for the original build.
