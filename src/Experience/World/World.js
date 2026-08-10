import Experience from "../Experience.js";
import SkyDome from "../../sky/SkyDome.js";
import Dunes from "./Dunes.js";
import Environment from "./Environment.js";
import Snow from "./Snow.js";
import Snowboard from "./Snowboard.js";
import Snowfall from "./Snowfall.js";
import Spray from "./Spray.js";

export default class World {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;

    this.environment = new Environment();
    this.skyDome = new SkyDome();
    this.dunes = new Dunes();
    this.snow = new Snow();
    this.snowboard = new Snowboard();
    this.snowfall = new Snowfall();
    this.spray = new Spray();
  }

  update(dt) {
    this.skyDome.update(dt);
    this.snow.update();
    this.snowboard.update(dt);
    this.snowfall.update(dt);
    this.spray.update(dt);
  }
}
