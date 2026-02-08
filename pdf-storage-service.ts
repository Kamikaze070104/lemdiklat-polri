/**
 * PDF Storage Service
 * Handles dynamic PDF storage with auto-cleanup functionality
 */

export interface StoredPdfInfo {
  id: string;
  name: string;
  originalName: string;
  size: number;
  uploadedAt: Date;
  filePath: string;
  summary?: string;
  isMetadataOnly?: boolean; // True if only metadata is stored (file too large for localStorage)
}

export class PdfStorageService {
  private static instance: PdfStorageService;
  private storageDir = './uploaded-content/pdfs';
  private indexFile = './uploaded-content/pdfs-index.json';
  private cleanupInterval: NodeJS.Timeout | null = null;
  private autoDeleteMinutes = 20; // Auto-delete after 1 minute for testing
  private maxFileSizeForLocalStorage = 10 * 1024 * 1024; // 10MB limit for localStorage
  private maxLocalStorageFiles = 10; // Maximum number of files in localStorage
  private onPdfDeletedCallback?: (pdfId: string) => void; // Callback for UI updates

  private constructor() {
    this.initializeStorage();
    this.startCleanupService();
  }

  static getInstance(): PdfStorageService {
    if (!PdfStorageService.instance) {
      PdfStorageService.instance = new PdfStorageService();
    }
    return PdfStorageService.instance;
  }

  async initialize(): Promise<void> {
    await this.initializeStorage();
  }

  setOnPdfDeletedCallback(callback: (pdfId: string) => void): void {
    this.onPdfDeletedCallback = callback;
  }

  private async initializeStorage(): Promise<void> {
    try {
      // Create storage directory if it doesn't exist
      if (typeof window === 'undefined') {
        // Server-side (Node.js)
        const fs = await import('fs');
        const path = await import('path');
        
        if (!fs.existsSync(this.storageDir)) {
          fs.mkdirSync(this.storageDir, { recursive: true });
        }
        
        // Create index file if it doesn't exist
        if (!fs.existsSync(this.indexFile)) {
          fs.writeFileSync(this.indexFile, JSON.stringify([]));
        }
      }
    } catch (error) {
      // Silent error handling for production
    }
  }

  async savePdf(file: File, summary?: string): Promise<StoredPdfInfo> {
    const id = this.generateId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${id}_${file.name}`;
    const filePath = `${this.storageDir}/${filename}`;

    const pdfInfo: StoredPdfInfo = {
      id,
      name: file.name,
      originalName: file.name,
      size: file.size,
      uploadedAt: new Date(),
      filePath,
      summary
    };

    try {
      if (typeof window === 'undefined') {
        // Server-side storage
        const fs = await import('fs');
        const buffer = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
      } else {
        // Client-side storage with proactive cleanup and better error handling
        await this.proactiveCleanup(); // Clean up before saving
        
        const canStoreLocally = await this.canStoreInLocalStorage(file);
        if (canStoreLocally) {
          try {
            await this.saveToClientStorage(pdfInfo, file);
          } catch (quotaError) {
            // If quota exceeded, force cleanup and try again
            await this.forceCleanupOldestFiles(3); // Remove 3 oldest files
            
            try {
              await this.saveToClientStorage(pdfInfo, file);
            } catch (retryError) {
              // Still failed, store metadata only
              pdfInfo.isMetadataOnly = true;
              // Save metadata to localStorage even if file content can't be stored
              await this.saveMetadataOnly(pdfInfo);
            }
          }
        } else {
          // Fallback: store only metadata, not the file content
          pdfInfo.isMetadataOnly = true;
          // Save metadata to localStorage
          await this.saveMetadataOnly(pdfInfo);
        }
      }

      await this.updateIndex(pdfInfo);
      
      return pdfInfo;
    } catch (error) {
      throw new Error(`Gagal menyimpan PDF: ${error.message}`);
    }
  }

  private async saveToClientStorage(pdfInfo: StoredPdfInfo, file: File): Promise<void> {
    // For client-side, we'll use localStorage with base64 encoding
    const base64 = await this.fileToBase64(file);
    const storageKey = `pdf_${pdfInfo.id}`;
    
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        ...pdfInfo,
        base64Data: base64
      }));
    } catch (error) {
       throw error;
     }
  }

  // Save only metadata without file content for large files
  private async saveMetadataOnly(pdfInfo: StoredPdfInfo): Promise<void> {
    try {
      const storageData = {
        ...pdfInfo,
        uploadedAt: pdfInfo.uploadedAt.toISOString(),
        isMetadataOnly: true
        // No fileData property for metadata-only entries
      };
      localStorage.setItem(`pdf_${pdfInfo.id}`, JSON.stringify(storageData));
     } catch (error) {
       throw error;
     }
  }

  private async fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]); // Remove data:application/pdf;base64, prefix
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async getAllPdfs(): Promise<StoredPdfInfo[]> {
    try {
      if (typeof window === 'undefined') {
        // Server-side
        const fs = await import('fs');
        if (fs.existsSync(this.indexFile)) {
          const data = fs.readFileSync(this.indexFile, 'utf8');
          const pdfs = JSON.parse(data);
          // Convert uploadedAt strings back to Date objects
          return pdfs.map((pdf: any) => ({
            ...pdf,
            uploadedAt: new Date(pdf.uploadedAt)
          }));
        }
      } else {
        // Client-side
        return this.getFromClientStorage();
      }
      return [];
    } catch (error) {
       return [];
     }
  }

  private getFromClientStorage(): StoredPdfInfo[] {
    const pdfs: StoredPdfInfo[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('pdf_')) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || '{}');
          pdfs.push({
            id: data.id,
            name: data.name,
            originalName: data.originalName,
            size: data.size,
            uploadedAt: new Date(data.uploadedAt),
            filePath: data.filePath,
            summary: data.summary,
            isMetadataOnly: data.isMetadataOnly || false
          });
        } catch (error) {
           // Silent error handling for production
         }
      }
    }
    return pdfs;
  }

  async deletePdf(id: string): Promise<boolean> {
    try {
      const pdfs = await this.getAllPdfs();
      const pdfToDelete = pdfs.find(pdf => pdf.id === id);
      
      if (!pdfToDelete) {
        return false;
      }

      if (typeof window === 'undefined') {
        // Server-side deletion
        const fs = await import('fs');
        if (fs.existsSync(pdfToDelete.filePath)) {
          fs.unlinkSync(pdfToDelete.filePath);
        }
      } else {
        // Client-side deletion
        localStorage.removeItem(`pdf_${id}`);
      }

      // Update index
      const updatedPdfs = pdfs.filter(pdf => pdf.id !== id);
      await this.saveIndex(updatedPdfs);
      
      return true;
    } catch (error) {
      return false;
    }
  }

  private async updateIndex(pdfInfo: StoredPdfInfo): Promise<void> {
    const pdfs = await this.getAllPdfs();
    pdfs.push(pdfInfo);
    await this.saveIndex(pdfs);
  }

  private async saveIndex(pdfs: StoredPdfInfo[]): Promise<void> {
    try {
      if (typeof window === 'undefined') {
        const fs = await import('fs');
        fs.writeFileSync(this.indexFile, JSON.stringify(pdfs, null, 2));
      }
      // For client-side, individual items are already saved in localStorage
    } catch (error) {
       // Silent error handling for production
     }
  }

  private startCleanupService(): void {
    // Run cleanup every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.runCleanup();
    }, 30000);
  }

  private async runCleanup(): Promise<void> {
    try {
      const pdfs = await this.getAllPdfs();
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - (this.autoDeleteMinutes * 60 * 1000));

      for (const pdf of pdfs) {
         const uploadDate = new Date(pdf.uploadedAt); // Fixed: use uploadedAt instead of uploadDate
         if (uploadDate < cutoffTime) {
           await this.deletePdf(pdf.id);
           
           // Notify UI about the deletion
           if (this.onPdfDeletedCallback) {
             this.onPdfDeletedCallback(pdf.id);
           }
         }
       }
     } catch (error) {
       // Silent error handling for production
     }
  }

  stopCleanupService(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  private async canStoreInLocalStorage(file: File): Promise<boolean> {
    try {
      // Check file size limit (more conservative limit for better performance)
       const maxFileSize = 3 * 1024 * 1024; // 3MB limit to avoid quota issues
       if (file.size > maxFileSize) {
         return false;
       }

       // Check current localStorage usage
       const currentFiles = this.getFromClientStorage();
       const maxFiles = 3; // Reduce max files to 3 for better quota management
       if (currentFiles.length >= maxFiles) {
         return false;
       }

      // More accurate localStorage space estimation
      const base64Overhead = 1.37; // Base64 encoding overhead (4/3 ratio + padding)
      const metadataSize = 500; // Estimated metadata size in bytes
      const estimatedTotalSize = Math.ceil(file.size * base64Overhead) + metadataSize;
      
      // Check available localStorage space more accurately
      try {
        // Get current localStorage usage
        let currentUsage = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            const value = localStorage.getItem(key) || '';
            currentUsage += key.length + value.length;
          }
        }
        
        // Estimate available space (localStorage limit is typically 5-10MB)
        const estimatedLimit = 5 * 1024 * 1024; // Conservative 5MB limit
        const availableSpace = estimatedLimit - currentUsage;
        
        if (estimatedTotalSize > availableSpace) {
           return false;
         }
         
         // Final test with a smaller sample to verify space
         const testKey = 'test_storage_capacity';
         const testSize = Math.min(estimatedTotalSize, 100 * 1024); // Test with up to 100KB
         const testData = 'x'.repeat(testSize);
         
         localStorage.setItem(testKey, testData);
         localStorage.removeItem(testKey);
         
         return true;
       } catch (quotaError) {
         return false;
       }
    } catch (error) {
       return false;
     }
  }

  // Proactive cleanup before saving new files
  private async proactiveCleanup(): Promise<void> {
    try {
      const pdfs = this.getFromClientStorage();
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - (this.autoDeleteMinutes * 60 * 1000));

      let deletedCount = 0;
      for (const pdf of pdfs) {
         const uploadDate = new Date(pdf.uploadedAt);
         if (uploadDate < cutoffTime) {
           localStorage.removeItem(`pdf_${pdf.id}`);
           deletedCount++;
           
           // Notify UI about the deletion
           if (this.onPdfDeletedCallback) {
             this.onPdfDeletedCallback(pdf.id);
           }
         }
       }
     } catch (error) {
       // Silent error handling for production
     }
  }

  // Force cleanup of oldest files when storage is full
  private async forceCleanupOldestFiles(count: number): Promise<void> {
    try {
       const pdfs = this.getFromClientStorage();
       
       if (pdfs.length === 0) {
         return;
       }
      
      // Sort by upload date (oldest first)
      pdfs.sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());
      
      const toDelete = pdfs.slice(0, Math.min(count, pdfs.length));
      let deletedCount = 0;
      
      for (const pdf of toDelete) {
         try {
           // Remove from localStorage
           localStorage.removeItem(`pdf_${pdf.id}`);
           deletedCount++;
           
           // Notify UI about the deletion
           if (this.onPdfDeletedCallback) {
             this.onPdfDeletedCallback(pdf.id);
           }
         } catch (deleteError) {
           // Silent error handling for production
         }
       }
       
       // Update the localStorage index to reflect deletions
       try {
         const remainingPdfs = this.getFromClientStorage();
       } catch (indexError) {
         // Silent error handling for production
       }
     } catch (error) {
       // Silent error handling for production
     }
  }

  // Get storage statistics with localStorage usage
  async getStorageStats(): Promise<{totalFiles: number, totalSize: number, localStorageUsage: string}> {
    const pdfs = await this.getAllPdfs();
    
    // Calculate localStorage usage
    let localStorageSize = 0;
    for (let key in localStorage) {
      if (key.startsWith('pdf_')) {
        localStorageSize += localStorage[key].length;
      }
    }
    
    return {
      totalFiles: pdfs.length,
      totalSize: pdfs.reduce((total, pdf) => total + pdf.size, 0),
      localStorageUsage: `${(localStorageSize / 1024 / 1024).toFixed(2)} MB`
    };
  }

  // Clear all PDF data from localStorage (emergency cleanup)
  async clearAllPdfStorage(): Promise<void> {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('pdf_')) {
          keysToRemove.push(key);
        }
      }
      
      keysToRemove.forEach(key => localStorage.removeItem(key));
       
       // Notify UI about all deletions
       if (this.onPdfDeletedCallback) {
         keysToRemove.forEach(key => {
           const id = key.replace('pdf_', '');
           this.onPdfDeletedCallback!(id);
         });
       }
     } catch (error) {
       // Silent error handling for production
     }
  }
}