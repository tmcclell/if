import {IImpactModelInterface} from '../interfaces';
import Spline from 'typescript-cubic-spline';
import * as AWS_INSTANCES from './aws-instances.json';
import * as AWS_EMBODIED from './aws-embodied.json';
import {KeyValuePair} from '../../types/boavizta';

export enum Interpolation {
  SPLINE = 'spline',
  LINEAR = 'linear',
}

export class TeadsAWS implements IImpactModelInterface {
  // Defined for compatibility. Not used in TEADS.
  authParams: object | undefined;
  // name of the data source
  name: string | undefined;
  // compute instances grouped by the provider with usage data
  private computeInstances: {
    [key: string]: KeyValuePair;
  } = {};

  // list of all the by Architecture
  private instanceType = '';
  private expectedLifespan = 4;
  private interpolation = Interpolation.LINEAR;

  constructor() {
    this.standardizeInstanceMetrics();
  }

  /**
   * Defined for compatibility. Not used in TEADS.
   */
  authenticate(authParams: object): void {
    this.authParams = authParams;
  }

  /**
   *  Configures the TEADS Plugin for IEF
   *  @param {string} name name of the resource
   *  @param {Object} staticParams static parameters for the resource
   *  @param {string} staticParams.instance_type instance type from the list of supported instances
   *  @param {number} staticParams.expected_lifespan expected lifespan of the instance in years
   *  @param {Interpolation} staticParams.interpolation expected lifespan of the instance in years
   */
  async configure(
    name: string,
    staticParams: object | undefined = undefined
  ): Promise<IImpactModelInterface> {
    this.name = name;

    if (staticParams === undefined) {
      throw new Error('Required Parameters not provided');
    }

    if ('instance_type' in staticParams) {
      const instanceType = staticParams?.instance_type as string;
      if (instanceType in this.computeInstances) {
        this.instanceType = instanceType;
      } else {
        throw new Error('Instance Type not supported');
      }
    } else if (this.instanceType === '') {
      throw new Error('Instance Type not provided');
    }

    if ('expected_lifespan' in staticParams) {
      this.expectedLifespan = staticParams?.expected_lifespan as number;
    }

    if ('interpolation' in staticParams) {
      this.interpolation = staticParams?.interpolation as Interpolation;
    }

    return this;
  }

  /**
   * Calculate the total emissions for a list of observations
   *
   * Each Observation require:
   *  @param {Object[]} observations  ISO 8601 datetime string
   *  @param {string} observations[].datetime ISO 8601 datetime string
   *  @param {number} observations[].duration observation duration in seconds
   *  @param {number} observations[].cpu percentage cpu usage
   */
  async calculate(
    observations: object | object[] | undefined
  ): Promise<object> {
    if (observations === undefined) {
      throw new Error('Required Parameters not provided');
    }
    if (!Array.isArray(observations)) {
      throw new Error('Observations should be an array');
    }

    if (this.instanceType === '') {
      throw new Error('Configuration is incomplete');
    }

    return observations.map((observation: KeyValuePair) => {
      this.configure(this.name!, observation);
      const e = this.calculateEnergy(observation);
      const m = this.embodiedEmissions(observation);
      observation['energy'] = e;
      observation['embodied'] = m;
      return observation;
    });
  }

  /**
   * Returns model identifier
   */
  modelIdentifier(): string {
    return 'teads.cloud.sci';
  }

  /**
   * Standardize the instance metrics for all the providers
   *
   * Maps the instance metrics to a standard format (min, max, idle, 10%, 50%, 100%) for all the providers
   */
  standardizeInstanceMetrics() {
    AWS_INSTANCES.forEach((instance: KeyValuePair) => {
      const cpus = parseInt(instance['Instance vCPU'], 10);
      this.computeInstances[instance['Instance type']] = {
        consumption: {
          idle: parseFloat(instance['Instance @ Idle'].replace(',', '.')),
          tenPercent: parseFloat(instance['Instance @ 10%'].replace(',', '.')),
          fiftyPercent: parseFloat(
            instance['Instance @ 50%'].replace(',', '.')
          ),
          hundredPercent: parseFloat(
            instance['Instance @ 100%'].replace(',', '.')
          ),
        },
        vCPUs: cpus,
        maxvCPUs: parseInt(instance['Platform Total Number of vCPU'], 10),
        name: instance['Instance type'],
      } as KeyValuePair;
    });
    AWS_EMBODIED.forEach((instance: KeyValuePair) => {
      this.computeInstances[instance['type']].embodiedEmission =
        instance['total'];
    });
  }

  /**
   * Calculates the energy consumption for a single observation
   * requires
   *
   * duration: duration of the observation in seconds
   * cpu: cpu usage in percentage
   * datetime: ISO 8601 datetime string
   *
   * Uses a spline method for AWS and linear interpolation for GCP and Azure
   */
  private calculateEnergy(observation: KeyValuePair) {
    if (
      !('duration' in observation) ||
      !('cpu' in observation) ||
      !('datetime' in observation)
    ) {
      throw new Error(
        'Required Parameters duration,cpu,datetime not provided for observation'
      );
    }

    //    duration is in seconds
    const duration = observation['duration'];

    //    convert cpu usage to percentage
    const cpu = observation['cpu'];

    //  get the wattage for the instance type

    const x = [0, 10, 50, 100];

    const y: number[] = [
      this.computeInstances[this.instanceType].consumption.idle ?? 0,
      this.computeInstances[this.instanceType].consumption.tenPercent ?? 0,
      this.computeInstances[this.instanceType].consumption.fiftyPercent ?? 0,
      this.computeInstances[this.instanceType].consumption.hundredPercent ?? 0,
    ];

    const spline = new Spline(x, y);

    let wattage = 0.0;
    if (this.interpolation === Interpolation.SPLINE) {
      wattage = spline.at(cpu);
    } else if (this.interpolation === Interpolation.LINEAR) {
      // base rate is from which level of cpu linear interpolation is applied at
      let base_rate = 0;
      let base_cpu = 0;
      let ratio = 0;
      // find the base rate and ratio
      for (let i = 0; i < x.length; i++) {
        if (cpu === x[i]) {
          base_rate = y[i];
          base_cpu = x[i];
          break;
        } else if (cpu > x[i] && cpu < x[i + 1]) {
          base_rate = y[i];
          base_cpu = x[i];
          ratio = (y[i + 1] - y[i]) / (x[i + 1] - x[i]);
          break;
        }
      }
      // sum of base_rate + (cpu - base_cpu) * ratio = total rate of cpu usage
      wattage = base_rate + (cpu - base_cpu) * ratio;
    }
    //  duration is in seconds
    //  wattage is in watts
    //  eg: 30W x 300s = 9000 J
    //  1 Wh = 3600 J
    //  9000 J / 3600 = 2.5 Wh
    //  J / 3600 = Wh
    //  2.5 Wh / 1000 = 0.0025 kWh
    //  Wh / 1000 = kWh
    // (wattage * duration) / (seconds in an hour) / 1000 = kWh
    return (wattage * duration) / 3600 / 1000;
  }

  /**
   * Calculates the embodied emissions for a given observation
   */
  private embodiedEmissions(observation: KeyValuePair): number {
    // duration
    const durationInHours = observation['duration'] / 3600;
    // M = TE * (TR/EL) * (RR/TR)
    // Where:
    // TE = Total Embodied Emissions, the sum of Life Cycle Assessment(LCA) emissions for all hardware components
    // TR = Time Reserved, the length of time the hardware is reserved for use by the software
    // EL = Expected Lifespan, the anticipated time that the equipment will be installed
    // RR = Resources Reserved, the number of resources reserved for use by the software.
    // TR = Total Resources, the total number of resources available.
    const totalEmissions =
      this.computeInstances[this.instanceType].embodiedEmission ?? 0;
    const timeReserved = durationInHours;
    const expectedLifespan = 8760 * this.expectedLifespan;
    const reservedResources =
      this.computeInstances[this.instanceType].vCPUs ?? 1.0;
    const totalResources =
      this.computeInstances[this.instanceType].maxVCPUs ?? 1.0;
    // Multiply totalEmissions by 1000 to convert from kgCO2e to gCO2e
    return (
      totalEmissions *
      1000 *
      (timeReserved / expectedLifespan) *
      (reservedResources / totalResources)
    );
  }
}
