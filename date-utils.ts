/**
 * Date normalization utilities for voice AI
 * Handles Indonesian relative date expressions
 */

export class DateNormalizer {
  /**
   * Normalize Indonesian relative date expressions to actual dates
   * @param dateExpression - User input like "besok", "lusa", "minggu depan"
   * @param baseDate - Base date to calculate from (default: today)
   * @returns Normalized date in YYYY-MM-DD format
   */
  static normalizeDate(dateExpression: string, baseDate: Date = new Date()): string {
    const normalized = dateExpression.toLowerCase().trim();
    const today = new Date(baseDate);
    
    // Reset time to avoid timezone issues
    today.setHours(0, 0, 0, 0);
    
    let targetDate = new Date(today);
    
    switch (normalized) {
      // Today variations
      case 'hari ini':
      case 'sekarang':
      case 'today':
        // targetDate is already today
        break;
        
      // Tomorrow variations
      case 'besok':
      case 'esok':
      case 'tomorrow':
        targetDate.setDate(today.getDate() + 1);
        break;
        
      // Day after tomorrow
      case 'lusa':
      case 'tulat':
      case 'day after tomorrow':
        targetDate.setDate(today.getDate() + 2);
        break;
        
      // Week-based
      case 'minggu depan':
      case 'next week':
        targetDate.setDate(today.getDate() + 7);
        break;
        
      case 'minggu ini':
      case 'this week':
        // Keep current date
        break;
        
      // Specific days of week
      case 'senin':
      case 'monday':
        targetDate = this.getNextWeekday(today, 1); // Monday = 1
        break;
        
      case 'selasa':
      case 'tuesday':
        targetDate = this.getNextWeekday(today, 2);
        break;
        
      case 'rabu':
      case 'wednesday':
        targetDate = this.getNextWeekday(today, 3);
        break;
        
      case 'kamis':
      case 'thursday':
        targetDate = this.getNextWeekday(today, 4);
        break;
        
      case 'jumat':
      case 'friday':
        targetDate = this.getNextWeekday(today, 5);
        break;
        
      case 'sabtu':
      case 'saturday':
        targetDate = this.getNextWeekday(today, 6);
        break;
        
      case 'minggu':
      case 'sunday':
        targetDate = this.getNextWeekday(today, 0); // Sunday = 0
        break;
        
      // Month-based
      case 'bulan depan':
      case 'next month':
        targetDate.setMonth(today.getMonth() + 1);
        break;
        
      default:
        // Try to parse as regular date format
        const parsedDate = this.parseIndonesianDate(normalized);
        if (parsedDate) {
          targetDate = parsedDate;
        }
        // If no match, return today
        break;
    }
    
    return this.formatDate(targetDate);
  }
  
  /**
   * Get the next occurrence of a specific weekday
   * @param baseDate - Starting date
   * @param targetDay - Target day (0=Sunday, 1=Monday, ..., 6=Saturday)
   * @returns Date object for the next occurrence
   */
  private static getNextWeekday(baseDate: Date, targetDay: number): Date {
    const currentDay = baseDate.getDay();
    const daysUntilTarget = (targetDay - currentDay + 7) % 7;
    
    // If it's the same day, get next week's occurrence
    const daysToAdd = daysUntilTarget === 0 ? 7 : daysUntilTarget;
    
    const result = new Date(baseDate);
    result.setDate(baseDate.getDate() + daysToAdd);
    return result;
  }
  
  /**
   * Parse Indonesian date formats
   * @param dateStr - Date string in Indonesian format
   * @returns Date object or null if parsing fails
   */
  private static parseIndonesianDate(dateStr: string): Date | null {
    // Handle formats like "15 januari", "20 feb", "3 maret 2025"
    const monthMap: { [key: string]: number } = {
      'januari': 0, 'jan': 0,
      'februari': 1, 'feb': 1,
      'maret': 2, 'mar': 2,
      'april': 3, 'apr': 3,
      'mei': 4, 'may': 4,
      'juni': 5, 'jun': 5,
      'juli': 6, 'jul': 6,
      'agustus': 7, 'agu': 7, 'aug': 7,
      'september': 8, 'sep': 8,
      'oktober': 9, 'okt': 9, 'oct': 9,
      'november': 10, 'nov': 10,
      'desember': 11, 'des': 11, 'dec': 11
    };
    
    // Try different patterns
    const patterns = [
      /(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?/, // "15 januari" or "15 januari 2025"
      /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/, // "15/1" or "15/1/2025"
      /(\d{4})-(\d{1,2})-(\d{1,2})/ // "2025-01-15"
    ];
    
    for (const pattern of patterns) {
      const match = dateStr.match(pattern);
      if (match) {
        if (pattern.source.includes('\\w+')) {
          // Indonesian month name format
          const day = parseInt(match[1]);
          const monthName = match[2].toLowerCase();
          const year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
          
          if (monthMap.hasOwnProperty(monthName)) {
            return new Date(year, monthMap[monthName], day);
          }
        } else if (pattern.source.includes('\\/')) {
          // DD/MM format
          const day = parseInt(match[1]);
          const month = parseInt(match[2]) - 1; // Month is 0-indexed
          const year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
          return new Date(year, month, day);
        } else {
          // YYYY-MM-DD format
          const year = parseInt(match[1]);
          const month = parseInt(match[2]) - 1;
          const day = parseInt(match[3]);
          return new Date(year, month, day);
        }
      }
    }
    
    return null;
  }
  
  /**
   * Format date to YYYY-MM-DD string
   * @param date - Date object to format
   * @returns Formatted date string
   */
  private static formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  /**
   * Get human-readable date description
   * @param dateStr - Date in YYYY-MM-DD format
   * @returns Human-readable description
   */
  static getDateDescription(dateStr: string): string {
    const targetDate = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    targetDate.setHours(0, 0, 0, 0);
    
    const diffTime = targetDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'hari ini';
    if (diffDays === 1) return 'besok';
    if (diffDays === 2) return 'lusa';
    if (diffDays === 7) return 'minggu depan';
    if (diffDays > 0 && diffDays < 7) return `${diffDays} hari lagi`;
    if (diffDays > 7) return `${Math.ceil(diffDays / 7)} minggu lagi`;
    if (diffDays < 0) return `${Math.abs(diffDays)} hari yang lalu`;
    
    return dateStr;
  }
  
  /**
   * Validate if a date string is valid and not in the past
   * @param dateStr - Date string to validate
   * @returns Validation result with message
   */
  static validateDate(dateStr: string): { isValid: boolean; message: string } {
    try {
      const targetDate = new Date(dateStr);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      targetDate.setHours(0, 0, 0, 0);
      
      if (isNaN(targetDate.getTime())) {
        return { isValid: false, message: 'Format tanggal tidak valid' };
      }
      
      if (targetDate < today) {
        return { isValid: false, message: 'Tanggal tidak boleh di masa lalu' };
      }
      
      // Check if date is too far in the future (e.g., more than 1 year)
      const oneYearFromNow = new Date(today);
      oneYearFromNow.setFullYear(today.getFullYear() + 1);
      
      if (targetDate > oneYearFromNow) {
        return { isValid: false, message: 'Tanggal terlalu jauh di masa depan' };
      }
      
      return { isValid: true, message: 'Tanggal valid' };
    } catch (error) {
      return { isValid: false, message: 'Error validasi tanggal' };
    }
  }
}