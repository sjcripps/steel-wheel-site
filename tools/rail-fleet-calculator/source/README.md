# Rail Fleet Calculator

Calculate optimal rail car fleet size and composition for your shipping operations.

## Inputs

- **Annual Tonnage**: Total annual volume in tons
- **Commodity Type**: Grain, steel, paper, chemicals, auto parts, or perishables
- **Trip Duration**: Average days from pickup to delivery
- **Peak Season Multiplier**: Adjustment factor for peak vs baseline (1.0 = baseline, 1.5 = 50% above average)
- **Target Utilization**: Desired car loading % (70-90% typical)
- **Dwell Time**: Days cars sit waiting/loading at facilities

## Calculation Logic

The calculator determines:
1. **Baseline Fleet**: Cars needed for average operations
2. **Peak Fleet**: Cars needed for peak season (baseline × peak multiplier)
3. **Fleet Composition**: Recommended primary car type by commodity
4. **Utilization Rate**: % of car capacity you're loading
5. **Cycle Time**: Days to cycle each car through your system
6. **Annual Trips**: Shipments per year based on trip duration

## Data Source

Car types and capacities based on Class I railroad standard specifications:
- Covered Hoppers: 100-ton grain, chemicals
- Gondolas: 100-ton steel, coal
- Boxcars: 80-ton paper, machinery
- Tank Cars: 120-ton liquids, chemicals
- Flat Cars: 50-ton machinery, auto parts
- Reefer Cars: 90-ton perishables

## Formula

```
Annual Trips = 365 / (Trip Days + Dwell Days)
Tons per Trip = Annual Tonnage / Annual Trips
Baseline Fleet = ceil(Tons per Trip / (Car Capacity × Utilization %))
Peak Fleet = ceil(Baseline Fleet × Peak Multiplier)
```

## Use Cases

- Planning new route fleet deployment
- Evaluating lease vs purchase economics
- Capacity planning for volume growth
- Seasonal peak planning
- Optimization of dwell time impact
