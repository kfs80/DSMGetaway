import argparse
import sys
from providers.ignav import IgnavProvider

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("origin")
    ap.add_argument("dest")
    ap.add_argument("dep")
    ap.add_argument("ret")
    args = ap.parse_args()
    
    p = IgnavProvider()
    if not p.available():
        print(f"Error: {p.why_unavailable}")
        sys.exit(1)
        
    print(f"Spot checking {args.origin} ⇄ {args.dest} for {args.dep} – {args.ret} via Ignav API...\n")
    
    try:
        out = p.cheapest_nonstop(args.origin, args.dest, args.dep, [])
        print(f"OUTBOUND ({args.dep}):")
        if out.price:
            print(f"  ${out.price} on {out.airline} ({out.flight}) departing at {out.depart_time}")
        else:
            print("  No nonstop found.")
            
        inn = p.cheapest_nonstop(args.dest, args.origin, args.ret, [])
        print(f"\nRETURN ({args.ret}):")
        if inn.price:
            print(f"  ${inn.price} on {inn.airline} ({inn.flight}) departing at {inn.depart_time}")
        else:
            print("  No nonstop found.")
            
        if out.price and inn.price:
            print(f"\nTOTAL BASE FARE: ${out.price + inn.price}")
            
    except Exception as e:
        print(f"Error querying Ignav: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
