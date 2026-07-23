#!/usr/bin/env python3
# Probe every credential in .env.sweep against its live service. Prints ONLY name -> status.
# Reads the env file internally; never prints a value; every probe is exception-wrapped.
import os, json, urllib.request, urllib.parse, hmac, hashlib, datetime, sys

ENVF = "/home/ubuntu/projects/steel-wheel-site/.env.sweep"
vals = {}
for line in open(ENVF):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        vals[k.strip()] = v.strip().strip('"')

def probe(url, headers=None, method="GET", data=None):
    try:
        h = dict(headers or {}); h.setdefault("User-Agent", "swl-env-probe/1.0")
        req = urllib.request.Request(url, headers=h, method=method, data=data)
        return urllib.request.urlopen(req, timeout=20).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return "ERR:" + type(e).__name__

out = []
def rep(name, status, note=""):
    ok = "✅" if status in (200, 201) else ("⚠️ " if status == "absent" else "❌")
    out.append(f"{ok} {name}: {status} {note}")

def has(*keys): return all(vals.get(k) for k in keys)

# AWS via sigv4 STS
if has("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
    try:
        ak, sk = vals["AWS_ACCESS_KEY_ID"], vals["AWS_SECRET_ACCESS_KEY"]
        region, service, host = "us-east-1", "sts", "sts.amazonaws.com"
        t = datetime.datetime.now(datetime.timezone.utc)
        amz, ds = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
        body = "Action=GetCallerIdentity&Version=2011-06-15"
        ch, sh = f"content-type:application/x-www-form-urlencoded\nhost:{host}\nx-amz-date:{amz}\n", "content-type;host;x-amz-date"
        creq = f"POST\n/\n\n{ch}\n{sh}\n{hashlib.sha256(body.encode()).hexdigest()}"
        scope = f"{ds}/{region}/{service}/aws4_request"
        sts_s = f"AWS4-HMAC-SHA256\n{amz}\n{scope}\n{hashlib.sha256(creq.encode()).hexdigest()}"
        sg = lambda k, m: hmac.new(k, m.encode(), hashlib.sha256).digest()
        kx = sg(sg(sg(sg(("AWS4" + sk).encode(), ds), region), service), "aws4_request")
        sig = hmac.new(kx, sts_s.encode(), hashlib.sha256).hexdigest()
        auth = f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={sh}, Signature={sig}"
        rep("AWS_ACCESS_KEY_ID+SECRET", probe(f"https://{host}/", {"Authorization": auth, "x-amz-date": amz,
            "Content-Type": "application/x-www-form-urlencoded"}, "POST", body.encode()), "(STS)")
    except Exception as e:
        rep("AWS_*", "ERR:" + type(e).__name__)
else:
    rep("AWS_*", "absent")

if has("TELEGRAM_BOT_TOKEN"):
    rep("TELEGRAM_BOT_TOKEN", probe(f"https://api.telegram.org/bot{vals['TELEGRAM_BOT_TOKEN']}/getMe"))
else: rep("TELEGRAM_BOT_TOKEN", "absent")

if has("TELEGRAM_CHAT_ID"): rep("TELEGRAM_CHAT_ID", 200, "(present; probed with bot above)")

if has("RESEND_API_KEY"):
    rep("RESEND_API_KEY", probe("https://api.resend.com/domains", {"Authorization": "Bearer " + vals["RESEND_API_KEY"]}))
else: rep("RESEND_API_KEY", "absent")

sup_url = vals.get("SUPABASE_URL") or vals.get("NEXT_PUBLIC_SUPABASE_URL")
if sup_url and has("SUPABASE_SERVICE_ROLE_KEY"):
    k = vals["SUPABASE_SERVICE_ROLE_KEY"]
    rep("SUPABASE_SERVICE_ROLE_KEY", probe(sup_url.rstrip("/") + "/rest/v1/", {"apikey": k, "Authorization": "Bearer " + k}))
else: rep("SUPABASE_SERVICE_ROLE_KEY", "absent")

if has("FLOWTRACK_PUBLIC_KEY", "FLOWTRACK_PRIVATE_KEY"):
    base = vals.get("FLOWTRACK_BASE_URL", "https://app.closegpt.ai").rstrip("/")
    q = urllib.parse.urlencode({"publicKey": vals["FLOWTRACK_PUBLIC_KEY"], "privateKey": vals["FLOWTRACK_PRIVATE_KEY"], "limit": 1})
    rep("FLOWTRACK_KEYS", probe(f"{base}/api/v1/contacts?{q}"))
else: rep("FLOWTRACK_KEYS", "absent")

probed = {"AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","RESEND_API_KEY",
          "SUPABASE_URL","NEXT_PUBLIC_SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY",
          "FLOWTRACK_PUBLIC_KEY","FLOWTRACK_PRIVATE_KEY","FLOWTRACK_BASE_URL"}
others = sorted(k for k in vals if k not in probed and not k.startswith("VERCEL_"))
print("\n".join(out))
print("\npresent-but-unprobed:", ", ".join(others) or "none")
