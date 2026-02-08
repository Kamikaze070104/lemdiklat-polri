/**
 * Jakarta Time Utilities for Voice AI
 * Handles WIB (Western Indonesia Time) timezone for proper greetings
 */

export class JakartaTimeUtils {
  /**
   * Get current time in Jakarta timezone (WIB = UTC+7)
   * @returns Date object adjusted to Jakarta timezone
   */
  static getCurrentJakartaTime(): Date {
    const now = new Date();
    // Convert to Jakarta time (UTC+7)
    const jakartaTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return jakartaTime;
  }

  /**
   * Get current hour in Jakarta timezone (0-23)
   * @returns number representing current hour in WIB
   */
  static getCurrentJakartaHour(): number {
    const jakartaTime = this.getCurrentJakartaTime();
    return jakartaTime.getUTCHours();
  }

  /**
   * Get appropriate greeting based on Jakarta time (WIB)
   * @returns string with appropriate Indonesian greeting
   */
  static getJakartaGreeting(): string {
    const hour = this.getCurrentJakartaHour();
    
    if (hour >= 5 && hour < 12) {
      return "selamat pagi";
    } else if (hour >= 12 && hour < 18) {
      return "selamat siang";
    } else {
      return "selamat malam";
    }
  }

  /**
   * Get formatted Jakarta time string
   * @returns string in format "HH:MM WIB"
   */
  static getFormattedJakartaTime(): string {
    const jakartaTime = this.getCurrentJakartaTime();
    const hours = jakartaTime.getUTCHours().toString().padStart(2, '0');
    const minutes = jakartaTime.getUTCMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes} WIB`;
  }

  /**
   * Get time period description in Indonesian
   * @returns string describing current time period
   */
  static getTimePeriodDescription(): string {
    const hour = this.getCurrentJakartaHour();
    
    if (hour >= 5 && hour < 12) {
      return "pagi";
    } else if (hour >= 12 && hour < 18) {
      return "siang";
    } else if (hour >= 18 && hour < 24) {
      return "malam";
    } else {
      return "dini hari";
    }
  }

  /**
   * Check if it's currently a specific time period in Jakarta
   * @param period - "pagi", "siang", "malam", or "dini hari"
   * @returns boolean indicating if current time matches the period
   */
  static isCurrentTimePeriod(period: string): boolean {
    return this.getTimePeriodDescription().toLowerCase() === period.toLowerCase();
  }

  /**
   * Get detailed time information for debugging
   * @returns object with detailed time information
   */
  static getDetailedTimeInfo(): {
    jakartaTime: string;
    hour: number;
    greeting: string;
    period: string;
    utcTime: string;
  } {
    const jakartaTime = this.getCurrentJakartaTime();
    const utcTime = new Date();
    
    return {
      jakartaTime: this.getFormattedJakartaTime(),
      hour: this.getCurrentJakartaHour(),
      greeting: this.getJakartaGreeting(),
      period: this.getTimePeriodDescription(),
      utcTime: utcTime.toISOString()
    };
  }
}