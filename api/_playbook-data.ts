// Carrier playbook data. Server-only ON PURPOSE.
//
// This used to be a <script type="application/json"> block inside
// tools/carrier-playbook/index.html, where the page's "sign-in required"
// gate was pure CSS -- it hid the DOM but shipped all 39 KB of quote
// channels, credit-setup notes and desk contacts to anyone who fetched the
// URL. Serving it from the session-checked `playbook` action instead means
// an unauthenticated request never receives the bytes.
//
// Keep this file underscore-prefixed: Vercel treats api/_*.ts as helpers,
// not routes, so it does not consume one of the 12 function slots.

export const PLAYBOOK = {
  "_meta": {
    "purpose": "Carrier Playbook data layer — per-railroad new-business quote channels, customer setup, third-party/payer-of-freight handling",
    "researched": "2026-07-22",
    "method": "Live fetches (WebFetch + Firecrawl for bot-blocked/JS pages). Every email/phone/URL below was seen on a fetched page unless labeled otherwise.",
    "verification_labels": {
      "VERIFIED-LIVE": "seen on a page fetched 2026-07-22",
      "ARCHIVED": "seen only in an archived/search snapshot",
      "NOT-FOUND": "searched, nothing public exists",
      "industry_knowledge": "not on a fetched page; low confidence, verify before relying on it"
    }
  },
  "railroads": [
    {
      "name": "Union Pacific (UP)",
      "quote_channel": {
        "type": "form-only (Salesforce web-to-lead); no public sales emails/phones",
        "url": "https://unionpacific.my.site.com/UP/s/?webToLead=True&leadSource=UPWebsite",
        "email": null,
        "phone": null,
        "notes": "Primary 'Contact a Shipping Expert' form, reason category 'Shipping with Union Pacific'. Vertical-specific intake forms: Automotive https://unionpacific.my.site.com/shipping/automotive/autos-contact ; Intermodal https://unionpacific.my.site.com/shipping/intermodal/other-contact ; Mexico https://unionpacific.my.site.com/shipping/mexico/icsc ; Economic & Industrial Development https://unionpacific.my.site.com/shipping/connect-to-rail/contacts . Ag, Chemicals, Energy, Machinery, Metals/Minerals/Forest all route through the main web-to-lead form. Hub: https://www.up.com/customer-contacts",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "1. Register company + request user ID: https://c02.my.uprr.com/crr/register/index.html",
          "2. Submit credit application (instead of cash-in-advance): https://c02.my.uprr.com/ccw/ui/secure/index.html#!/ccw1 — credit questions: creditgroup@up.com (M-F 8am-4:30pm CT)",
          "3. Sign up for Invoice Management: https://www.up.com/shipping/resources/invoice-management (support 877-712-4687)",
          "4. Set shipment notifications in MyUPRR",
          "Then type-specific paths: Carload / Intermodal / Unit Train (location verification, pricing confirmation, equipment registration — behind login)"
        ],
        "portal_url": "https://c02.my.uprr.com/myu_myuprr/secure/myuprr-3.0/index.html#/home",
        "credit_notes": "creditgroup@up.com. First Time Rail Shipper Checklist: https://www.up.com/shipping/onboarding-steps . eBusiness/portal support 800-872-1045; 24h customer care 800-272-8777 (existing customers).",
        "freshness": "VERIFIED-LIVE"
      },
      "third_party_notes": "Letter of Authority (LOA) required for any 3rd-party logistics/technology company managing rail shipments that is NOT a party to the waybill — covers CLMs, EDI 417/322/622, web access, phone data access. Online LOA system: https://c02.my.uprr.com/loa/secure/index.html#/search (login required); questions 800-872-1045; ~3 business days to activate; 1-month-to-5-year terms; EDI messaging fees apply to third parties. Page: https://www.up.com/customers/all/letter-of-authority/ [VERIFIED-LIVE]. If SWL is payer of freight (party to waybill), the standard credit application path applies; UP ITC defines 'Customer' to include the party primarily responsible for paying line-haul charges.",
      "credit_setup": {
        "application": {
          "access": "PORTAL-GATED — register first at https://c02.my.uprr.com/crr/register/index.html , then apply inside the CCW tool: https://c02.my.uprr.com/ccw/ui/secure/index.html#!/ccw1 . No public PDF; no published field list.",
          "url": "https://c02.my.uprr.com/ccw/ui/secure/index.html#!/ccw1",
          "fields_preview": [
            "No published field list — the app lives behind the my.uprr.com login.",
            "Sequence per First Time Rail Shipper Checklist: register company -> submit credit application ('instead of having to pay cash in advance') -> Invoice Management signup -> notifications."
          ],
          "processing": "No published credit timeline. (LOA activation ~3 business days.)",
          "terms": "Not published. Credit questions: creditgroup@up.com (M-F 8am-4:30pm CT); portal support 800-872-1045.",
          "contact": "creditgroup@up.com"
        },
        "badges": [
          {
            "tone": "info",
            "text": "Credit app behind CCW portal registration"
          }
        ],
        "third_party": "Letter of Authority (LOA) — DATA ACCESS only, NOT billing. Online submission (login required): https://c02.my.uprr.com/loa/secure/index.html#/search . Terms 1 month to 5 years max; activation ~3 business days; renewal notices 30 days pre-expiry; EDI messaging fees apply to third parties. If SWL's client is payer of freight, the client does the credit app; SWL takes an LOA for visibility.",
        "prepay": "Cash in advance is the stated default before credit is established. No published prepay procedure — arrange via creditgroup@up.com."
      },
      "vertical_desks": [
        "Automotive",
        "Agricultural Products",
        "Chemicals & Plastics",
        "Energy & Renewables",
        "Intermodal",
        "Machinery & Oversized",
        "Metals, Minerals & Forest",
        "Mexico (cross-border)"
      ],
      "sources": [
        "https://www.up.com/customers/index.htm",
        "https://www.up.com/customer-contacts",
        "https://www.up.com/shipping/onboarding-steps",
        "https://www.up.com/shipping/how-to-ship-by-rail",
        "https://www.up.com/customers/all/letter-of-authority/"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    },
    {
      "name": "BNSF Railway",
      "quote_channel": {
        "type": "form-only; no public sales emails/phones",
        "url": "https://customer2.bnsf.com/s/get-a-freight-rate",
        "email": null,
        "phone": null,
        "notes": "'Get a Freight Rate' self-serve tool. New-company lead intake: https://customer2.bnsf.com/s/customer-onboarding?language=en_US&id=BNSF.com%20-%20Lead ('Never shipped with BNSF' path). General contact form: https://www.bnsf.com/about-bnsf/contact-us-form.page . Intermodal has its own contact page: https://www.bnsf.com/ship-with-bnsf/intermodal/contact-us.html",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "Prepare before applying: company HQ/website, commodities, infrastructure/service needs, volumes + seasonality, desired start date, origins/destinations",
          "Submit customer-onboarding form (new company) OR register as employee-of-existing-customer for web tools/PIN",
          "Portal registration: https://custreg.bnsf.com/",
          "Published timeline: 'General time for setup and processing is approximately two weeks, but this can vary greatly depending on approvals and urgency'"
        ],
        "portal_url": "https://customer2.bnsf.com/",
        "credit_notes": "Credit application details not published pre-onboarding; handled inside the onboarding flow.",
        "freshness": "VERIFIED-LIVE"
      },
      "third_party_notes": "NOT-FOUND publicly. No public Rule 11 / payer-of-freight / non-broker-third-party setup guidance on bnsf.com (Rule 11 appears only inside commodity price-list PDFs). Engage via the customer-onboarding lead form and state the payer-of-freight arrangement there.",
      "credit_setup": {
        "application": {
          "access": "PUBLIC ONLINE FORM (Salesforce). Info page: https://www.bnsf.com/ship-with-bnsf/credit-application.html ; actual form: https://da0000000kurzma4.my.salesforce-sites.com/bnsfcreditapplication (Spanish version exists for Mexican entities). Prerequisite: 'Connecting with a BNSF representative is a necessary first step prior to applying for credit.'",
          "url": "https://da0000000kurzma4.my.salesforce-sites.com/bnsfcreditapplication",
          "fields_preview": [
            "Screen 1: Company name, physical street address (no P.O. boxes), year established, ownership type, DUNS, Credit Amount Requested, what you are shipping in (Railcars/Trailers/Containers). Later screens load client-side (not captured).",
            "'Credit is required if your Company plans to be the payer of freight.' Intermodal storage-guarantee-only applicants skip the credit app (register at custreg.bnsf.com)."
          ],
          "processing": "Credit app up to 3 business days before first shipment; overall setup 'approximately two weeks, but this can vary greatly'.",
          "terms": "15-day carload / 7-day intermodal & 3PL / 30-day misc; finance charge 0.033%/day (12%/yr, Rule Book 6100 C). Written notice required for ownership/name changes."
        },
        "badges": [
          {
            "tone": "info",
            "text": "<=3 days credit app / ~2wk total setup"
          },
          {
            "tone": "gate",
            "text": "Sales-rep contact is a formal prerequisite"
          }
        ],
        "third_party": "Client authorization letter — must be signed by the authorizing party OR sent from the authorizing party's email address at the corresponding company; indicate authorized functions in the 'other' field. Handled through third-party registration at https://custreg.bnsf.com/ ; support eBizHelp@bnsf.com / 888-428-2673.",
        "prepay": "Cash in advance — no general public procedure (raise it in the onboarding lead form). Documented niche: dimensional 'Pay for Proposal' pre-clearance at $2,000/request — 'Customers without credit with BNSF will be required to pay with a credit card.'"
      },
      "vertical_desks": [
        "Agricultural Products",
        "Automotive Products",
        "Consumer Products (Intermodal)",
        "Energy",
        "Food & Beverages",
        "Industrial Products"
      ],
      "sources": [
        "https://www.bnsf.com/ship-with-bnsf/",
        "https://www.bnsf.com/ship-with-bnsf/new-to-rail.page"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    },
    {
      "name": "CSX Transportation",
      "quote_channel": {
        "type": "form + published new-business emails (no new-business phone)",
        "url": "https://movewithcsx.com/",
        "email": "merchandise@csx.com (carload) | go_intermodal@csx.com (intermodal BCO) | RailPlus_Sales@csx.com (door-to-door, IMC, private asset)",
        "phone": null,
        "notes": "'Move with CSX' form is the primary new-business intake (from https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/become-a-customer/). New-to-rail contact page lists the three sales emails by segment: https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/contact-us/ . New/returning-after-6-months shippers must clear Service Start-Up & Integration (SSUI) feasibility: https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/service-start-up-and-integration/ (has its own contact form). csx.com blocks plain fetchers (403) — use a browser/scraper.",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "1. Submit Move with CSX form -> CSX rep reaches out",
          "2. Service Start-Up & Integration group validates feasibility for new locations / >6-month-dormant lanes",
          "3. Register for ShipCSX (plan/ship/trace/pay) — register from a desktop PC",
          "New-to-rail education: Railroad 101 https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/railroad-101 ; Get Acquainted https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/get-acquainted"
        ],
        "portal_url": "https://www.shipcsx.com/",
        "credit_notes": "Credit application not published publicly; handled after sales contact. eBusiness support: 1-877-ShipCSX (1-877-744-7279), option 2.",
        "freshness": "VERIFIED-LIVE"
      },
      "third_party_notes": "Partial. RailPlus_Sales@csx.com explicitly covers new Intermodal Marketing Company (IMC) customers — the published third-party channel on the intermodal side. No public Rule 11 / carload payer-of-freight setup doc found on csx.com [NOT-FOUND].",
      "credit_setup": {
        "application": {
          "access": "PUBLIC ONLINE FORM, full field list captured: https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/become-a-customer/credit-application/ (csx.com 403s plain fetchers — use a real browser).",
          "url": "https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/become-a-customer/credit-application/",
          "fields_preview": [
            "Tax ID, DUNS (customer + parent), principal officer name/title, primary commodity, name of CSX sales rep, Credit Amount Expected PER WEEK (or # anticipated moves).",
            "Bank reference (bank name, contact name+title, full address, phone) + trade references + electronic signature of authorized officer.",
            "Payment method: ACH Debit (preferred — needs Financial Institution details + Transit Routing/ABA Number + Account Number; not for Canadian customers), ACH Credit, or Wire."
          ],
          "processing": "Selecting ACH Debit = automatic acceptance ('CSXT will automatically accept credit application if ACH Debit selected') — fastest documented credit path of any Class I. No other timeline published.",
          "terms": "Payment in full within 15 days of bill date; credit checks + ongoing monitoring authorized; governed by Florida law. Credit Dept J-675, 500 Water Street, Jacksonville FL 32202.",
          "contact": "CSXTCreditAdmin@csx.com"
        },
        "badges": [
          {
            "tone": "lever",
            "text": "⚡ ACH-Debit = automatic acceptance (needs bank acct + ABA)"
          }
        ],
        "third_party": "No public agency/LOA form. The credit form itself has a 3PL variant — the embedded '3PL Electronic Funds Transfer Debit Authorization Agreement' and '3PL Credit Agreement' terms show CSX explicitly credits 3PLs as payers. Intermodal third parties (IMCs) route via RailPlus_Sales@csx.com.",
        "prepay": "Pay before release: 'For prepaid shipments, freight and other accrued transportation charges must be paid prior to release of the shipment to the railroad. For collect shipments, all transportation charges must be paid prior to placement of the shipment at the destination.'"
      },
      "vertical_desks": [
        "Carload/merchandise (merchandise@csx.com)",
        "Intermodal BCO (go_intermodal@csx.com)",
        "RailPlus door-to-door / IMC / private asset (RailPlus_Sales@csx.com)",
        "Commodities index: https://www.csx.com/index.cfm/customers/commodities/"
      ],
      "sources": [
        "https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/become-a-customer/",
        "https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/contact-us/",
        "https://movewithcsx.com/"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22 (via Firecrawl; csx.com 403s plain fetchers)"
    },
    {
      "name": "Norfolk Southern (NS)",
      "quote_channel": {
        "type": "per-industry embedded forms + published vertical desk emails and named sales directors",
        "url": "https://www.norfolksouthern.com/en/ship-by-rail/industry",
        "email": "ns.chemicals@nscorp.com (chemicals) | automotivemarketing@nscorp.com (automotive) | Ics@nscorp.com (intermodal customer service)",
        "phone": "(855) 667-3655 (main)",
        "notes": "Each industry page has a 'Ready to Start a New Shipment?' embedded form (name/email/zip/commodity/STCC) + named sales contacts. Verified examples: Chemicals — Sean Kelly (Industrial Chemicals) 470-599-7391 Sean.Kelly@nscorp.com; Kristian Staum (Energy, Sand, Waste) 540-266-8060 Kristian.Staum@nscorp.com. Ag/Forest — beau.stdennis@nscorp.com. Metals/Construction — connie.mcclung2@nscorp.com. Intermodal — patrick.stager@nscorp.com, nick.chamberlin@nscorp.com, Amber.Gartrell@nscorp.com, Javier.Herrera3@nscorp.com. Existing customers: customerservice@nscorp.com / 800-635-5768. Industrial development (new rail-served facility): https://www.norfolksouthern.com/en/rail-development-property/industrial-rail-development/tell-us-more-about-your-project",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "1. Contact industry desk via form/email -> matched with team member",
          "2. Register for AccessNS: https://ns-registration-pl-accessns.web.ocp4.nscorp.com/home/registration",
          "3. Rate requests + business conducted in AccessNS: https://accessns.nscorp.com/auth/login",
          "First-time shipper guide: https://www.norfolksouthern.com/en/ship-by-rail/shipping-tools/how-does-rail-shipping-work"
        ],
        "portal_url": "https://accessns.nscorp.com/auth/login",
        "credit_notes": "Credit application not published publicly; handled after sales contact.",
        "freshness": "VERIFIED-LIVE"
      },
      "third_party_notes": "NOT-FOUND publicly. No public Rule 11 / payer-of-freight / logistics-provider setup page. Route through the industry-desk form and state the arrangement.",
      "credit_setup": {
        "application": {
          "access": "PUBLIC ONLINE FORM, full field list captured: https://credit-application-eads.web.ocp4.nscorp.com/#/credit-application/credit-application-form (linked from https://www.norfolksouthern.com/en/ship-by-rail/shipping-tools/business-solutions/billing-financing ).",
          "url": "https://credit-application-eads.web.ocp4.nscorp.com/#/credit-application/credit-application-form",
          "fields_preview": [
            "Bank reference WITH account number (checking/savings + types of loans), 3 trade references (unaffiliated; transportation companies preferred), financial statements (audited preferred, unaudited accepted).",
            "Tax ID, DUNS, estimated shipments/month (cars AND trailers), monthly credit amount (USD), NS sales contact name, person responsible for paying freight bills.",
            "Must be signed by an officer or authorized employee before review starts. Optional signed 'Appendix' eliminates finance charges."
          ],
          "processing": "No published timeline. Reapply if no shipments within 12 months of a prior application.",
          "terms": "Not published beyond the finance-charge Appendix. Credit Dept: CreditDeptMailbox@nscorp.com, Box 10, 650 West Peachtree St NW, Atlanta GA 30308 (Robert Sumwalt (470) 463-7498; Judy Schamber (470) 463-6680).",
          "contact": "CreditDeptMailbox@nscorp.com"
        },
        "badges": [
          {
            "tone": "gate",
            "text": "Officer signature required before review starts"
          },
          {
            "tone": "info",
            "text": "Bank ref w/ account # + 3 transport trade refs"
          }
        ],
        "third_party": "No public agency form. The form itself distinguishes the Bill To Party from the 'person responsible for paying freight bills' contact — route arrangements through the industry-desk rep.",
        "prepay": "'Customers without credit should contact The Cash Application Group at CashAppDL@nscorp.com to arrange prepayment.' Dimensional shipments: prepay by wire via tncyoadm@nscorp.com / 404-589-6107 or -6108; wire must cover freight + fuel surcharge + accessorials."
      },
      "vertical_desks": [
        "Agriculture & Forest",
        "Automotive",
        "Chemicals",
        "Coal",
        "Intermodal",
        "Metals & Construction"
      ],
      "sources": [
        "https://www.norfolksouthern.com/en/ship-by-rail",
        "https://www.norfolksouthern.com/en/ship-by-rail/industry/chemicals",
        "https://www.norfolksouthern.com/en/ship-by-rail/industry/agriculture-forest",
        "https://www.norfolksouthern.com/en/ship-by-rail/industry/automotive",
        "https://www.norfolksouthern.com/en/ship-by-rail/industry/metals-construction",
        "https://www.norfolksouthern.com/en/ship-by-rail/industry/intermodal"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    },
    {
      "name": "CN (Canadian National)",
      "quote_channel": {
        "type": "sales phone line + email-sales link + per-commodity product specialists",
        "url": "https://www.cn.ca/en/contact-us/",
        "email": "via 'Email Sales' link on contact page (form-mediated)",
        "phone": "1-888-668-4626 (sales, new business)",
        "notes": "Contact page lists product specialists by commodity (Automotive, Coal/Pet Coke, Dimensional, Fertilizer, Forest Products, Grain, Hazmat, Consumer Goods, Metals/Minerals, Frac Sand, Petroleum/Chemicals) in expandable sections. First question CN asks: 'Carload or Intermodal?'. EXISTING-customer service (do not use for new business): carload 1-866-926-7245; intermodal 1-866-851-7837; US retail 1-866-482-6025; CA retail 1-866-896-6601; customs/EDI 24/7 1-800-267-9779; intermodal email serviceclientIM@cn.ca.",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "1. Call/email sales with: origin+destination, weight, time/temp sensitivity, cross-border needs, equipment type, rail siding access (list from new-to-rail page)",
          "2. Register for CN eBusiness / CN One: https://ecprod.cn.ca/cis/#/register (support 1-800-361-0198)",
          "New-to-rail guide: https://www.cn.ca/en/customer-centre/new-to-rail"
        ],
        "portal_url": "https://ecprod.cn.ca/cis/",
        "credit_notes": "Credit setup not published on public pages; arranged via sales.",
        "freshness": "VERIFIED-LIVE"
      },
      "third_party_notes": "Best public Rule 11 documentation of the six: eBusiness help file defines Rule 11 (pre-paid to intermediate point, collect beyond; each carrier invoices its segment; valid Rule 11 payer of freight required per segment): https://www.cn.ca/en/ebusiness/content/help-files/ebusiness-helpfiles-shipping-instructions/patterns-blocks/rule-11/ . Empty private railcar moves must be billed Rule 11 with valid payer: https://www.cn.ca/-/media/Files/Customer-Centre/Shipping-Equipment/private-empty-railcar-process-en.pdf [ARCHIVED — found via search, not re-fetched].",
      "credit_setup": {
        "application": {
          "access": "NOT PUBLIC — no shipper credit application form or requirements anywhere on cn.ca (the only 'credit' documents there are CN's own supplier-side credit reference letters). Start via the sales line 1-888-668-4626 (new business), then CN eBusiness/CN One registration: https://ecprod.cn.ca/cis/#/register (support 1-800-361-0198).",
          "url": null,
          "fields_preview": [
            "No published field list — credit is arranged through sales."
          ],
          "processing": "No published timeline.",
          "terms": "Not published."
        },
        "badges": [
          {
            "tone": "info",
            "text": "Not public — start via the sales line"
          }
        ],
        "third_party": "No public agency form. CN does publish the best Rule 11 documentation of the six (valid per-segment payer of freight required): https://www.cn.ca/en/ebusiness/content/help-files/ebusiness-helpfiles-shipping-instructions/patterns-blocks/rule-11/",
        "prepay": "NOT PUBLIC — nothing published; arrange via the sales line (1-888-668-4626) first."
      },
      "vertical_desks": [
        "Automotive",
        "Coal/Petroleum Coke",
        "Dimensional Loads",
        "Fertilizer",
        "Forest Products",
        "Grain",
        "Hazardous Materials",
        "Consumer Goods",
        "Metals/Minerals",
        "Frac Sand",
        "Petroleum/Chemicals"
      ],
      "sources": [
        "https://www.cn.ca/en/contact-us/",
        "https://www.cn.ca/en/customer-centre/new-to-rail"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    },
    {
      "name": "CPKC (Canadian Pacific Kansas City)",
      "quote_channel": {
        "type": "published per-commodity sales desk directory (names + direct emails + phones) + request-information form",
        "url": "https://www.cpkcr.com/en/contact-us/sales-contacts",
        "email": "examples: IM_PricingUSA@cpkcr.com (US domestic intermodal, 877-225-5277); wheat_pricing@cpkcr.com / oilseeds_pricing@cpkcr.com / grain_pricing@cpkcr.com / ag_productspricing@cpkcr.com (grain desks); marcus.tyrance@cpkcr.com (US chemicals, 904-776-5565); aaman.mann@cpkcr.com (fertilizer/potash); matthias.bennett@cpkcr.com (coal/pet coke); jamie.senin@cpkcr.com (automotive CA/US)",
        "phone": "877-225-5277 (intermodal sales & pricing US/CA)",
        "notes": "Most transparent Class I: full sales directory by commodity x country (Canada/US/Mexico) with named reps. Mexico desks use @cpkcm.mx addresses. Also a Request Information form: https://www.cpkcr.com/en/customer-resources/become-a-customer/Request-Information-Form1 . Rail-served facility development: https://www.cpkcr.com/en/contact-us/rail-development-contacts . Pages are JS-rendered — plain fetchers get empty shells; use a scraper.",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "1. Establish a quote via the commodity sales contact (sales-contacts page)",
          "2. Establish credit BEFORE shipping: online app https://www.cpkcr.com/en/customer-resources/become-a-customer/credit-application (US/CA); Mexico-origin uses KCSM PDF app https://www.cpkcr.com/content/dam/cpkc/customer-resources/become-a-customer/kcsm-credit-application%20English.pdf . 'Once your credit is approved, you officially become a CPKC customer.'",
          "3. Onboarding session: Onboarding@cpkcr.com / 1-888-333-8111 (domestic intermodal + all carload); Brandon.Ellis@cpkcr.com / 1-204-947-8199 (international intermodal). Onboarding team runs a checklist (equipment, facility, reporting requirements) with your Account Manager",
          "4. Portal signup: Customer Station (US/CA origins) or MyKCS (Mexico origins)"
        ],
        "portal_url": "https://www8.cpr.ca/cpcustomerstation (US/CA) | https://mykcs.kcsouthern.com/MyKCS/ (MX)",
        "credit_notes": "Credit is an explicit pre-shipping gate; CPKC 'may cancel previously-issued credit at any time'. Steps page: https://www.cpkcr.com/en/customer-resources/become-a-customer",
        "freshness": "VERIFIED-LIVE"
      },
      "third_party_notes": "No public Rule 11 / non-broker third-party setup doc [NOT-FOUND]. The credit-application gate is party-agnostic (whoever will be invoiced applies). Personal-vehicle/household/LTL shippers are redirected to partners (e.g., Hansen's Forwarding) — signals CPKC routes non-carload third-party arrangements through sales desks.",
      "credit_setup": {
        "application": {
          "access": "PUBLIC ONLINE FORM (US/CA): https://www.cpkcr.com/en/customer-resources/become-a-customer/credit-application — prerequisite: obtain a shipping quote FIRST. 'Once your credit is approved, you officially become a CPKC customer.' Mexico-origin (KCSM) uses a PDF app submitted to solicitudcredito@kcsms.com.mx. Help: Credit Department 1-877-404-0433.",
          "url": "https://www.cpkcr.com/en/customer-resources/become-a-customer/credit-application",
          "fields_preview": [
            "TIN, DUNS, incorporation officers (name & title), CPKC sales rep name, estimated annual value of shipments (USD), credit limit requested (USD), target date of first shipment.",
            "Bank reference (name, address, contact name+title, phone, email) + 3 trade references (company, contact, phone, email).",
            "Required documents emailed to Credit_Department@cpkcr.com: (1) Articles of Incorporation / government registration; (2) recent 2-year AUDITED financial statements (balance sheet, income, cash flow — NDA available); (3) tax-exemption certificate if applicable."
          ],
          "processing": "KCSM: 7-10 business days (incomplete apps auto-rejected). US/CA: not stated — the audited-financials requirement means expect the slowest diligence of the six for a young company.",
          "terms": "Net 15 from invoice date; 18%/yr interest on past dues (Tariff 1 items 11100/21000). Credit is discretionary and can be cancelled any time. KCSM: prepaid cash basis until credit established; late interest 2%/mo (MXN) / 1.5%/mo (USD); annual financial reports required ongoing.",
          "contact": "Credit_Department@cpkcr.com"
        },
        "badges": [
          {
            "tone": "gate",
            "text": "⛔ Requires 2-yr audited financials — use prepay fallback"
          },
          {
            "tone": "info",
            "text": "KCSM 7-10 business days"
          }
        ],
        "third_party": "No public agency form. The credit gate is party-agnostic — whoever will be invoiced applies.",
        "prepay": "Published fallback on the credit page: '1. You can pay for your shipments in cash prior to movement (this only applies to carload shipments) and may result in manual-processing charges. For Intermodal shipments, a security deposit is required. 2. A performance security that meets our requirements can be accepted.'"
      },
      "vertical_desks": [
        "Aggregates",
        "Appliances & Consumer Goods",
        "Automotive",
        "Chemicals",
        "Coal & Petroleum Coke",
        "Fertilizer & Potash",
        "Food Products",
        "Forest/Paper/Pulp",
        "Grain (4 sub-desks by crop)",
        "Intermodal Domestic",
        "Intermodal International"
      ],
      "sources": [
        "https://www.cpkcr.com/en/customer-resources/become-a-customer",
        "https://www.cpkcr.com/en/contact-us/sales-contacts"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22 (via Firecrawl; site is JS-rendered)"
    },
    {
      "name": "TRRA (Terminal Railroad Association of St. Louis)",
      "quote_channel": {
        "type": "single general customer-service email + phone; no dedicated sales/marketing contact published",
        "url": "https://terminalrailroadstl.odoo.com/contactus",
        "email": "TRRAclerks@TerminalRailroad.com",
        "phone": "+1 (618) 451-8443 (customer service) | (618) 451-8400 (main office)",
        "notes": "Site canonical host is terminalrailroadstl.odoo.com (terminalrailroad.com serves a bad TLS cert). Address: 1017 Olive St, 5th Floor, St. Louis, MO 63101. Services: switching, car repair/mechanical & locomotive services, industrial development, car storage. Tariffs/demurrage pages on same site.",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "No published customer-setup process. Contact TRRAclerks@TerminalRailroad.com. As an intermediate switching carrier, switching charges are typically absorbed into or billed via the line-haul Class I — commercial arrangements usually flow through the connecting Class I serving the customer."
        ],
        "portal_url": null,
        "credit_notes": "None published.",
        "freshness": "VERIFIED-LIVE (contacts) / NOT-FOUND (setup process)"
      },
      "third_party_notes": "Nothing published. Owned by the Class I railroads (site: 'owned by five Class I railroads' and serves CPKC as the sixth); interchanges with all six. Route pricing questions through the line-haul carrier first, TRRA clerks for switching/terminal specifics.",
      "vertical_desks": [],
      "sources": [
        "https://terminalrailroadstl.odoo.com/home4",
        "https://terminalrailroadstl.odoo.com/contactus"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    },
    {
      "name": "WSOR (Wisconsin & Southern Railroad — Watco)",
      "quote_channel": {
        "type": "named commodity sales reps with direct emails/phones (best short-line transparency of the four)",
        "url": "https://www.watco.com/service/rail/wsor/",
        "email": "jamaar.benton@watco.com (Metals, Minerals, Petroleum, Chemicals, Machinery, Forest Products) | bpeot@watco.com (Grain, Grain Products, Fertilizer, Canned Foods)",
        "phone": "Jamaar Benton (608) 235-9066 | Brad Peot (608) 445-3852 | Customer Service (866) 889-2826 ext 1",
        "notes": "wsorrailroad.com 301-redirects to watco.com/service/rail/wsor/. Owned/operated by Watco. GM: Tyler Crawford (608) 620-2042 tcrawford@watco.com. General CS email Cs1@watco.com. Railcar services railcaradmin@watco.com (620) 704-1528. Operations: 1890 E Johnson St, Madison, WI 53704, (608) 620-2055.",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "Contact the commodity-matched sales rep for a quote; tariff/pricing sheets published on the Watco railroads pages. No published portal or credit-application flow — arranged via sales/Watco corporate."
        ],
        "portal_url": null,
        "credit_notes": "None published. Invoicing disputes: wsordisputes@watco.com.",
        "freshness": "VERIFIED-LIVE (contacts) / NOT-FOUND (formal setup process)"
      },
      "third_party_notes": "Nothing published on third parties/Rule 11. Watco is itself a logistics company — sales reps handle non-shipper arrangements directly.",
      "vertical_desks": [
        "Metals/Minerals/Petroleum/Chemicals/Machinery/Forest (Benton)",
        "Grain/Fertilizer/Canned Foods (Peot)"
      ],
      "sources": [
        "https://www.watco.com/service/rail/wsor/"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    },
    {
      "name": "BRC (Belt Railway Company of Chicago)",
      "quote_channel": {
        "type": "general customer-service email/phone only; no sales/marketing dept published",
        "url": "https://beltrailway.com/customers/industries/",
        "email": "customerservice@beltrailway.com",
        "phone": "Industry Clerk 708-496-4171 | Customer Service 708-496-4117 (24/7)",
        "notes": "Jointly owned switching carrier — about page lists owners: BNSF, Canadian National, Canadian Pacific (now CPKC), CSX, Norfolk Southern, Union Pacific. Commercial arrangements typically flow through the owner/connecting Class I; BRC publishes its switching tariffs at https://beltrailway.com/customers/tariffs/ . Existing-customer portal: portal.beltrailway.com (car tracing).",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "No published new-customer process. Contact Industry Clerk / customer service; rate structure is tariff-published. Facility development: site mentions 'industrial and intermodal facility development opportunities' but names no contact."
        ],
        "portal_url": "https://portal.beltrailway.com",
        "credit_notes": "None published.",
        "freshness": "VERIFIED-LIVE (contacts) / NOT-FOUND (setup process)"
      },
      "third_party_notes": "Nothing published. As an intermediate switching carrier, line-haul pricing including BRC switching is normally quoted by the Class I; go to BRC directly only for terminal services (switching, storage) via the numbers above.",
      "vertical_desks": [],
      "sources": [
        "https://beltrailway.com/customers/industries/",
        "https://beltrailway.com/about-2/",
        "https://beltrailway.com/customers/tariffs/"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    },
    {
      "name": "IHB (Indiana Harbor Belt Railroad)",
      "quote_channel": {
        "type": "rate-request email + named business development contacts (phone only for BD staff)",
        "url": "https://www.ihbrr.com/business-development",
        "email": "ihb.marketing@ihbrr.com (rate requests)",
        "phone": "Patrick McShane, Director of Business Development & Joint Facilities: (219) 989-4955 | James Pecyna, Sr. Manager of Business Development (Chicago Transloading & Warehousing): (219) 989-4974 / (708) 689-3164",
        "notes": "Largest switch carrier in the US; 320-mile network around Chicago. Customer service/car tracing: agency@ihbrr.com (708) 201-3460. Equipment orders: ihb.carorder@ihbrr.com. Dimensional/hi-wide: hiwide@ihbrr.com (219) 989-4816. BOL transmission: ihbbol@ihbrr.com. No BD staff emails published — phone/fax only, rate requests by email.",
        "freshness": "VERIFIED-LIVE"
      },
      "setup": {
        "steps": [
          "No published customer-setup process. Email ihb.marketing@ihbrr.com for rates; station list PDF at https://www.ihbrr.com/resources/docs/busdev/ (IHB Stations)."
        ],
        "portal_url": null,
        "credit_notes": "None published.",
        "freshness": "VERIFIED-LIVE (contacts) / NOT-FOUND (setup process)"
      },
      "third_party_notes": "Nothing published. Ownership not stated on ihbrr.com; commonly cited as jointly owned via Conrail (CSX/NS) and CPKC [industry_knowledge, confidence: low — verify]. Site's employee portal runs on nscorp.com infrastructure. As a switching carrier, line-haul arrangements flow through connecting Class I's; contact IHB directly for switching, transloading, warehousing.",
      "vertical_desks": [
        "Chicago Transloading & Warehousing (Pecyna)"
      ],
      "sources": [
        "https://www.ihbrr.com/",
        "https://www.ihbrr.com/contact-us",
        "https://www.ihbrr.com/business-development"
      ],
      "freshness": "VERIFIED-LIVE 2026-07-22"
    }
  ],
  "fallback_directory": {
    "name": "ASLRRA Railroad Member Directory (public)",
    "url": "https://engage.aslrra.org/railroad-id",
    "notes": "Public search of short line/regional railroads by state of operation and/or commodity hauled, with links to each railroad's website. Supplier directory: https://engage.aslrra.org/supplier . Landing page: https://www.aslrra.org/member-directory/ . Member-only portal adds route miles, reporting marks, 286k capability, car repair/storage/warehouse flags. Use this when a lane touches a short line not yet in this playbook.",
    "freshness": "VERIFIED-LIVE 2026-07-22"
  },
  "new_to_rail_guides": [
    {
      "railroad": "UP",
      "url": "https://www.up.com/shipping/onboarding-steps",
      "title": "First Time Rail Shipper Checklist"
    },
    {
      "railroad": "UP",
      "url": "https://www.up.com/shipping/how-to-ship-by-rail",
      "title": "How To Ship By Rail"
    },
    {
      "railroad": "BNSF",
      "url": "https://www.bnsf.com/ship-with-bnsf/new-to-rail.page",
      "title": "New to Rail (lists what BNSF will ask: commodities, volumes, seasonality, locations, start date)"
    },
    {
      "railroad": "CSX",
      "url": "https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/railroad-101",
      "title": "Railroad 101"
    },
    {
      "railroad": "CSX",
      "url": "https://www.csx.com/index.cfm/customers/new-to-csx-or-rail/service-start-up-and-integration/",
      "title": "Service Start-Up and Integration"
    },
    {
      "railroad": "NS",
      "url": "https://www.norfolksouthern.com/en/ship-by-rail/shipping-tools/how-does-rail-shipping-work",
      "title": "How Does Rail Shipping Work?"
    },
    {
      "railroad": "CN",
      "url": "https://www.cn.ca/en/customer-centre/new-to-rail",
      "title": "New to Rail (lists quote inputs CN will ask for)"
    },
    {
      "railroad": "CPKC",
      "url": "https://www.cpkcr.com/en/customer-resources/become-a-customer",
      "title": "Become a Customer (4-step: quote -> credit -> onboarding -> portal)"
    }
  ],
  "gaps": [
    "UP + BNSF publish NO sales emails/phones — form-only new-business channels (Salesforce web-to-lead / customer-onboarding lead form). Expect to enter the funnel via form and get a rep assigned.",
    "CSX publishes no new-business phone number — form (movewithcsx.com) + three segment emails only.",
    "Credit application terms/timelines: only BNSF (~2 weeks setup) and CPKC (credit approval = customer status) publish anything; UP/CSX/NS/CN credit terms are behind the sales process.",
    "Rule 11 / payer-of-freight setup for a non-broker logistics provider: only CN documents Rule 11 publicly; UP's Letter of Authority covers data access (not billing) for third parties. BNSF/CSX/NS/CPKC have nothing public — must be raised with the assigned rep. UFC 6000-series Rule 62 governs credit/collection terms (referenced in UP ITC).",
    "CN per-commodity specialist names/numbers sit in expandable JS sections; only the general sales line (1-888-668-4626) and structure were extractable. Call the sales line and ask for the commodity specialist.",
    "IHB business development contacts have no published emails (phone/fax only); ownership not stated on their site.",
    "BRC and TRRA publish no sales/marketing/BD contact at all — general customer service only; commercial arrangements flow through owner Class I's.",
    "NS named sales directors verified for chemicals/ag/metals/intermodal pages only; other verticals use the same page pattern (embedded form + desk email) — harvest per-page as needed."
  ]
} as const;

// Draft-email routing per road — MOVED OFF THE CLIENT 2026-07-23.
//
// This block used to sit inline in tools/carrier-playbook/index.html. The
// b60b3b3 commit moved the main PLAYBOOK server-side but missed this, so an
// unauthenticated `curl` of the tool URL still returned 22 addresses --
// including named carrier staff and the commodity desk each one owns
// (NS Ag & Forest, CPKC fertilizer/potash, WSOR metals, ...). That mapping is
// researched competitive material and a harvesting target for those inboxes,
// so it ships only after the server has authorised the request.
//
// Desk labels that quote a railroad's own product name (e.g. CSX's
// go_intermodal / "Intermodal BCO" desk) keep THEIR naming, verbatim.
export const DRAFT_CONFIG =   {
    up: {
      mode: 'form',
      formUrl: 'https://unionpacific.my.site.com/UP/s/?webToLead=True&leadSource=UPWebsite',
      formLabel: "UP 'Contact a Shipping Expert' form (Salesforce web-to-lead)"
    },
    bnsf: {
      mode: 'form',
      formUrl: 'https://customer2.bnsf.com/s/get-a-freight-rate',
      formLabel: "BNSF 'Get a Freight Rate' tool (new company: customer-onboarding form)"
    },
    csx: {
      mode: 'email',
      formUrl: 'https://movewithcsx.com/',
      desks: [
        { label: 'Carload / merchandise', addr: 'merchandise@csx.com' },
        { label: 'Intermodal BCO desk (their product name)', addr: 'go_intermodal@csx.com' },
        { label: 'RailPlus door-to-door / IMC / private asset', addr: 'RailPlus_Sales@csx.com' }
      ]
    },
    ns: {
      mode: 'email',
      formUrl: 'https://www.norfolksouthern.com/en/ship-by-rail/industry',
      desks: [
        { label: 'Chemicals desk', addr: 'ns.chemicals@nscorp.com' },
        { label: 'Automotive desk', addr: 'automotivemarketing@nscorp.com' },
        { label: 'Ag & Forest (Beau St. Dennis)', addr: 'beau.stdennis@nscorp.com' },
        { label: 'Metals & Construction (Connie McClung)', addr: 'connie.mcclung2@nscorp.com' }
      ]
    },
    cn: {
      mode: 'form',
      cnIntake: true, // renders CN's REAL intake form (captured 2026-07-22), pre-filled — not the generic paste-block
      formUrl: 'https://www.cn.ca/en/contact-us/',
      formLabel: "CN contact page — call sales first: 1-888-668-4626 (email is form-mediated). CN's first question: 'Carload or Intermodal?' (their phrasing)"
    },
    cpkc: {
      mode: 'email',
      formUrl: 'https://www.cpkcr.com/en/customer-resources/become-a-customer/Request-Information-Form1',
      desks: [
        { label: 'Grain pricing', addr: 'grain_pricing@cpkcr.com' },
        { label: 'Wheat pricing', addr: 'wheat_pricing@cpkcr.com' },
        { label: 'Oilseeds pricing', addr: 'oilseeds_pricing@cpkcr.com' },
        { label: 'Ag products pricing', addr: 'ag_productspricing@cpkcr.com' },
        { label: 'US chemicals (Marcus Tyrance)', addr: 'marcus.tyrance@cpkcr.com' },
        { label: 'Fertilizer / potash (Aaman Mann)', addr: 'aaman.mann@cpkcr.com' },
        { label: 'Coal / pet coke (Matthias Bennett)', addr: 'matthias.bennett@cpkcr.com' },
        { label: 'Automotive CA/US (Jamie Senin)', addr: 'jamie.senin@cpkcr.com' },
        { label: 'US domestic desk (their "IM Pricing USA")', addr: 'IM_PricingUSA@cpkcr.com' }
      ]
    },
    trra: {
      mode: 'email',
      desks: [{ label: 'TRRA clerks (customer service)', addr: 'TRRAclerks@TerminalRailroad.com' }]
    },
    wsor: {
      mode: 'email',
      desks: [
        { label: 'Metals/Minerals/Petroleum/Chemicals/Machinery/Forest (Jamaar Benton)', addr: 'jamaar.benton@watco.com' },
        { label: 'Grain/Fertilizer/Canned Foods (Brad Peot)', addr: 'bpeot@watco.com' }
      ]
    },
    brc: {
      mode: 'email',
      desks: [{ label: 'Customer service', addr: 'customerservice@beltrailway.com' }]
    },
    ihb: {
      mode: 'email',
      desks: [{ label: 'Rate requests (IHB marketing)', addr: 'ihb.marketing@ihbrr.com' }]
    }
  } as const;
