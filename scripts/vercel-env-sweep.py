#!/usr/bin/env python3
# Vercel env health sweep for the SWL project: pull each env var (decrypted via API),
# live-probe the credential against its service, print ONLY name -> status. Never a value.
# Run: keyring.sh run VT=vercel -- python3 scripts/vercel-env-sweep.py
import os, json, urllib.request, urllib.parse, hmac, hashlib, datetime

VT = os.environ["VT"]

def vapi(path):
    req = urllib.request.Request("https://api.vercel.com" + path,
                                 headers={"Authorization": "Bearer " + VT})
    return json.load(urllib.request.urlopen(req, timeout=30))

# find the SWL project
projects = vapi("/v9/projects?limit=100").get("projects", [])
proj = None
for p in projects:
    name = p.get("name", "")
    if "steel" in name.lower() or "swl" in name.lower():
        proj = p; break
if not proj:
    print("projects visible:", [p["name"] for p in projects][:20])
    raise SystemExit("no SWL project found")
pid = proj["id"]
print(f"project: {proj['name']} ({pid})")

envs = vapi(f"/v9/projects/{pid}/env?decrypt=true").get("envs", [])
vals = {}
for e in envs:
    if e.get("type") in ("encrypted", "plain") and e.get("value"):
        vals[e["key"]] = e["value"]
print(f"env vars pulled: {len(vals)}\n")

def probe_http(url, headers=None, method="GET", data=None, ua=True):
    h = dict(headers or {})
    if ua: h.setdefault("User-Agent", "swl-env-sweep/1.0")
    req = urllib.request.Request(url, headers=h, method=method, data=data)
    try:
        r = urllib.request.urlopen(req, timeout=20)
        return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return f"ERR:{str(e)[:40]}"

results = []
def check(name, status, note=""):
    ok = "✅" if status is True or status in (200, 201) else "❌"
    results.append(f"{ok} {name}: {status} {note}")

# --- AWS ---
ak, sk = vals.get("AWS_ACCESS_KEY_ID"), vals.get("AWS_SECRET_ACCESS_KEY")
if ak and sk:
    # sigv4 STS GetCallerIdentity
    region, service, host = "us-east-1", "sts", "sts.amazonaws.com"
    t = datetime.datetime.now(datetime.timezone.utc)
    amz_date, datestamp = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
    body = "Action=GetCallerIdentity&Version=2011-06-15"
    ch = f"content-type:application/x-www-form-urlencoded\nhost:{host}\nx-amz-date:{amz_date}\n"
    sh = "content-type;host;x-amz-date"
    creq = f"POST\n/\n\n{ch}\n{sh}\n{hashlib.sha256(body.encode()).hexdigest()}"
    scope = f"{datestamp}/{region}/{service}/aws4_request"
    sts = f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{hashlib.sha256(creq.encode()).hexdigest()}"
    def sign(key, msg): return hmac.new(key, msg.encode(), hashlib.sha256).digest()
    kd = sign(("AWS4" + sk).encode(), datestamp); kr = sign(kd, region); ks = sign(kr, service); kx = sign(ks, "aws4_request")
    sig = hmac.new(kx, sts.encode(), hashlib.sha256).hexdigest()
    auth = f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={sh}, Signature={sig}"
    st = probe_http(f"https://{host}/", headers={"Authorization": auth, "x-amz-date": amz_date,
                    "Content-Type": "application/x-www-form-urlencoded"}, method="POST", data=body.encode(), ua=False)
    check("AWS_ACCESS_KEY_ID/SECRET", st, "(STS GetCallerIdentity)")
else:
    check("AWS_*", "missing", "(not set in Vercel)")

# --- Telegram ---
tg = vals.get("TELEGRAM_BOT_TOKEN")
if tg: check("TELEGRAM_BOT_TOKEN", probe_http(f"https://api.telegram.org/bot{tg}/getMe"))
else: check("TELEGRAM_BOT_TOKEN", "missing")

# --- Resend ---
rk = vals.get("RESEND_API_KEY")
if rk: check("RESEND_API_KEY", probe_http("https://api.resend.com/domains", headers={"Authorization": "Bearer " + rk}))
else: check("RESEND_API_KEY", "missing")

# --- Supabase ---
su, sks_ = vals.get("SUPABASE_URL") or vals.get("NEXT_PUBLIC_SUPABASE_URL"), vals.get("SUPABASE_SERVICE_ROLE_KEY")
if su and sks_:
    check("SUPABASE_SERVICE_ROLE_KEY", probe_http(su.rstrip("/") + "/rest/v1/?apikey=" + urllib.parse.quote(sks_),
          headers={"Authorization": "Bearer " + sks_}))
else: check("SUPABASE (url+service key)", "missing one or both")

# --- FlowTrack ---
fpub, fpriv, fbase = vals.get("FLOWTRACK_PUBLIC_KEY"), vals.get("FLOWTRACK_PRIVATE_KEY"), vals.get("FLOWTRACK_BASE_URL", "https://app.closegpt.ai")
if fpub and fpriv:
    check("FLOWTRACK_KEYS", probe_http(f"{fbase.rstrip('/')}/api/v1/contacts?limit=1&publicKey={fpub}&privateKey={fpriv}"))
else: check("FLOWTRACK_KEYS", "missing")

# --- anything else that looks like a secret: report presence only ---
known = {"AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","TELEGRAM_BOT_TOKEN","RESEND_API_KEY",
         "SUPABASE_URL","NEXT_PUBLIC_SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY",
         "FLOWTRACK_PUBLIC_KEY","FLOWTRACK_PRIVATE_KEY","FLOWTRACK_BASE_URL"}
others = [k for k in vals if k not in known]

print("\n".join(results))
print("\nunprobed vars (present, no live check written):", ", ".join(sorted(others)) or "none")
